//! 渲染与上屏（跨平台，只依赖 wgpu）：一个设备、每张钉图一张源图纹理（GPU 上生成 mip）、
//! 每个窗口一个 wgpu Surface。这里不出现任何平台类型：Surface 由平台层给的
//! `SurfaceTargetUnsafe` 建出来（Windows 是 DComp 视觉对象，macOS 是 CAMetalLayer，Wayland 是 wl_surface）。

use std::time::Instant;

use bytemuck::{Pod, Zeroable};

use crate::geom::{Rect, View};

pub struct Gpu {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    instance: wgpu::Instance,
    pin_layout: wgpu::BindGroupLayout,
    pin_pipeline: wgpu::RenderPipeline,
    mip_layout: wgpu::BindGroupLayout,
    mip_pipeline: wgpu::RenderPipeline,
    trilinear: wgpu::Sampler,
}

/// 一张钉图的源图（GPU 纹理，带完整 mip 链）。
pub struct Image {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

/// 一个窗口的上屏面。
pub struct Surface {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    uniform: wgpu::Buffer,
    bind: Option<wgpu::BindGroup>,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PinUniform {
    origin: [f32; 2],
    turn: u32,
    opacity: f32,
    content: [f32; 4],
    crop: [f32; 4],
}

/// 一次绘制的耗时（毫秒）。
#[derive(Debug, Clone, Copy, Default)]
pub struct DrawTiming {
    /// 改交换链尺寸（只在尺寸变了时）。
    pub configure: f64,
    /// 取下一个后台缓冲（可能等合成）。
    pub acquire: f64,
    /// 录命令、提交、Present。
    pub submit: f64,
}

const SURFACE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

impl Gpu {
    pub fn new() -> Result<Gpu, String> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = wgpu::Backends::DX12;
        let instance = wgpu::Instance::new(desc);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|e| format!("没有可用的显卡：{e}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("pins"),
            // 大图要 16384 的纹理边长；其余取默认。
            required_limits: wgpu::Limits {
                max_texture_dimension_2d: adapter.limits().max_texture_dimension_2d,
                ..Default::default()
            },
            // 钉图不是游戏：小块分配，显存按需长（`PROBE_MEMHINT=perf` 时用 wgpu 的默认大块，对照用）。
            memory_hints: if std::env::var("PROBE_MEMHINT").as_deref() == Ok("perf") {
                wgpu::MemoryHints::Performance
            } else {
                wgpu::MemoryHints::MemoryUsage
            },
            ..Default::default()
        }))
        .map_err(|e| format!("建设备失败：{e}"))?;

        let pin_shader = device.create_shader_module(wgpu::include_wgsl!("pin.wgsl"));
        let mip_shader = device.create_shader_module(wgpu::include_wgsl!("mip.wgsl"));
        let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let smp_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let pin_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pin"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                tex_entry(1),
                smp_entry(2),
            ],
        });
        let mip_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mip"),
            entries: &[tex_entry(0), smp_entry(1)],
        });
        let pipeline = |layout: &wgpu::BindGroupLayout,
                        shader: &wgpu::ShaderModule,
                        format: wgpu::TextureFormat| {
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[Some(layout)],
                ..Default::default()
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: Some(&pl),
                vertex: wgpu::VertexState {
                    module: shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: shader,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let pin_pipeline = pipeline(&pin_layout, &pin_shader, SURFACE_FORMAT);
        let mip_pipeline = pipeline(
            &mip_layout,
            &mip_shader,
            wgpu::TextureFormat::Rgba8UnormSrgb,
        );
        let trilinear = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("trilinear"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: 1,
            ..Default::default()
        });
        Ok(Gpu {
            adapter,
            device,
            queue,
            instance,
            pin_layout,
            pin_pipeline,
            mip_layout,
            mip_pipeline,
            trilinear,
        })
    }

    pub fn describe(&self) -> String {
        let i = self.adapter.get_info();
        format!("{}（{:?}，驱动 {}）", i.name, i.backend, i.driver_info)
    }

    /// 上传 RGBA8（sRGB 编码、直通 alpha）并在 GPU 上生成 mip。
    pub fn upload(&self, width: u32, height: u32, rgba: &[u8]) -> Image {
        let levels = 32 - width.max(height).leading_zeros();
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("source"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let mut enc = self.device.create_command_encoder(&Default::default());
        let level_view = |l: u32| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: l,
                mip_level_count: Some(1),
                ..Default::default()
            })
        };
        for l in 1..levels {
            let src = level_view(l - 1);
            let dst = level_view(l);
            let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.mip_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&src),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.trilinear),
                    },
                ],
            });
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &dst,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.mip_pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([enc.finish()]);
        let view = texture.create_view(&Default::default());
        Image {
            texture,
            view,
            width,
            height,
        }
    }

    /// 由平台层给的目标建上屏面。
    ///
    /// # Safety
    /// `target` 指向的平台对象要活得比返回的 Surface 久。
    pub unsafe fn surface(&self, target: wgpu::SurfaceTargetUnsafe) -> Result<Surface, String> {
        let surface = unsafe { self.instance.create_surface_unsafe(target) }
            .map_err(|e| format!("建 Surface 失败：{e}"))?;
        let caps = surface.get_capabilities(&self.adapter);
        if !caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            return Err(format!("不支持预乘 alpha：{:?}", caps.alpha_modes));
        }
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: SURFACE_FORMAT,
            color_space: Default::default(),
            width: 0,
            height: 0,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 1,
            alpha_mode: wgpu::CompositeAlphaMode::PreMultiplied,
            view_formats: vec![],
        };
        let uniform = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pin"),
            size: std::mem::size_of::<PinUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Ok(Surface {
            surface,
            config,
            uniform,
            bind: None,
        })
    }

    /// 把钉图画进窗口 `window`（屏幕矩形）的上屏面并 Present。尺寸变了就先改交换链。
    pub fn draw(
        &self,
        s: &mut Surface,
        image: &Image,
        window: Rect,
        content: Rect,
        view: &View,
    ) -> Result<DrawTiming, String> {
        let mut timing = DrawTiming::default();
        let (w, h) = (window.w.max(1) as u32, window.h.max(1) as u32);
        if s.config.width != w || s.config.height != h {
            let t = Instant::now();
            s.config.width = w;
            s.config.height = h;
            s.surface.configure(&self.device, &s.config);
            timing.configure = ms(t);
        }
        if s.bind.is_none() {
            s.bind = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.pin_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: s.uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&image.view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.trilinear),
                    },
                ],
            }));
        }
        let t = Instant::now();
        let frame = match s.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            other => return Err(format!("取不到后台缓冲：{other:?}")),
        };
        timing.acquire = ms(t);
        let t = Instant::now();
        let u = PinUniform {
            origin: [window.x as f32, window.y as f32],
            turn: u32::from(view.rotation % 4)
                | if view.flip_h { 4 } else { 0 }
                | if view.flip_v { 8 } else { 0 },
            opacity: view.opacity,
            content: [
                content.x as f32,
                content.y as f32,
                content.w as f32,
                content.h as f32,
            ],
            crop: [0.0, 0.0, 1.0, 1.0],
        };
        self.queue.write_buffer(&s.uniform, 0, bytemuck::bytes_of(&u));
        let target = frame.texture.create_view(&Default::default());
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pin_pipeline);
            pass.set_bind_group(0, s.bind.as_ref().unwrap(), &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(frame);
        timing.submit = ms(t);
        Ok(timing)
    }

    /// 等 GPU 做完已提交的工作（只在测量时用）。
    pub fn wait_idle(&self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}
