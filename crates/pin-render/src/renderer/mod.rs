//! GPU 设备、上传、上屏与读回。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::block_on::block_on;
use crate::uniform::{self, PinUniform, Source};
use crate::{CURVE_SIZE, Draw, Error, LUT_SIZE, LutData, Pixels, RgbaImage};

mod draw;
mod upload;

/// 每个设备一个编号；句柄记下自己属于哪个设备，重建后旧句柄报 [`Error::Stale`]。
static GENERATION: AtomicU64 = AtomicU64::new(1);

/// 建设备一次只建一个：几个线程同时建 WARP 设备时进程会崩（访问冲突，本机实测）。
static CREATING: std::sync::Mutex<()> = std::sync::Mutex::new(());

const SOURCE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const OFFSCREEN_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// 持有 GPU 设备与管线。没有钉图时调用方可以整个丢掉它，释放设备。
pub struct Renderer {
    generation: u64,
    fallback_only: bool,
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    lost: Arc<AtomicBool>,
    pin_layout: wgpu::BindGroupLayout,
    pin_shader: wgpu::ShaderModule,
    /// 按输出格式建的钉图管线（窗口用 BGRA，读回用 RGBA）。
    pin_pipelines: std::sync::Mutex<Vec<(wgpu::TextureFormat, wgpu::RenderPipeline)>>,
    mip_layout: wgpu::BindGroupLayout,
    mip_pipeline: wgpu::RenderPipeline,
    /// 没有查找表或说明层时绑上的占位纹理。
    empty_lut: wgpu::TextureView,
    empty_curve: wgpu::TextureView,
    empty_overlay: wgpu::TextureView,
}

/// 一张钉图的源图：带完整 mip 链的纹理。
pub struct Image {
    generation: u64,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    levels: u32,
}

impl Image {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }
}

/// 到某台显示器的查找表。
#[derive(Debug)]
pub struct Lut {
    generation: u64,
    /// `None` 为恒等。
    tables: Option<(wgpu::TextureView, wgpu::TextureView)>,
    /// 着色器的查找表标志（`uniform::LUT_IDENTITY`、`uniform::LUT_LINEAR`）。
    bits: u32,
}

/// 说明层：预乘 alpha 的 RGBA8，sRGB 编码。
#[derive(Debug)]
pub struct Overlay {
    generation: u64,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

/// 一个窗口槽的上屏面。
pub struct Surface {
    generation: u64,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    configured: bool,
}

/// wgpu 的显存分配器报告（字节）：已分配给资源的与向驱动申请的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryReport {
    pub allocated: u64,
    pub reserved: u64,
}

impl Renderer {
    /// 建设备：Windows 用 DX12，macOS 用 Metal，Linux 用 Vulkan；显存按小块按需分配
    /// （`MemoryHints::MemoryUsage`）。没有硬件适配器时用后备适配器（Windows 上是 WARP）。
    pub fn new() -> Result<Renderer, Error> {
        Renderer::create(false)
    }

    /// 只用后备适配器（软件渲染，Windows 上是 WARP）。没有显卡的机器走的就是这条路，
    /// 测试用它在有显卡的机器上复现。
    pub fn new_fallback() -> Result<Renderer, Error> {
        Renderer::create(true)
    }

    fn create(fallback_only: bool) -> Result<Renderer, Error> {
        let _creating = CREATING.lock().unwrap_or_else(|e| e.into_inner());
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(desc);
        let request = |fallback| {
            block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: fallback,
                compatible_surface: None,
                ..Default::default()
            }))
        };
        let adapter = if fallback_only {
            request(true)
        } else {
            request(false).or_else(|_| request(true))
        }
        .map_err(|e| Error::NoAdapter(e.to_string()))?;
        let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("pins"),
            // 大图要用到设备支持的最大纹理边长；其余取默认。
            required_limits: wgpu::Limits {
                max_texture_dimension_2d: adapter.limits().max_texture_dimension_2d,
                ..wgpu::Limits::default()
            },
            // 钉图不是游戏：小块分配、按需长。默认的 Performance 一开始就占约 170 MB 显存。
            memory_hints: wgpu::MemoryHints::MemoryUsage,
            ..Default::default()
        }))
        .map_err(|e| Error::Device(e.to_string()))?;

        let lost = Arc::new(AtomicBool::new(false));
        let flag = lost.clone();
        device.set_device_lost_callback(move |_, _| flag.store(true, Ordering::Release));
        // 所有调用都包在错误作用域里，漏出来的错误不该让进程崩溃（默认处理是 panic）。
        device.on_uncaptured_error(Arc::new(|_| {}));

        let texture_entry = |binding, dimension| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: dimension,
                multisampled: false,
            },
            count: None,
        };
        use wgpu::TextureViewDimension::{D2, D3};
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
                texture_entry(1, D2),
                texture_entry(2, D3),
                texture_entry(3, D2),
                texture_entry(4, D2),
                texture_entry(5, D3),
                texture_entry(6, D2),
            ],
        });
        let mip_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mip"),
            entries: &[texture_entry(0, D2)],
        });
        let pin_shader = device.create_shader_module(wgpu::include_wgsl!("../pin.wgsl"));
        let mip_shader = device.create_shader_module(wgpu::include_wgsl!("../mip.wgsl"));
        let mip_pipeline = pipeline(&device, &mip_layout, &mip_shader, SOURCE_FORMAT);

        let empty = |dimension, format| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("empty"),
                    size: wgpu::Extent3d {
                        width: 1,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension,
                    format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };
        let empty_lut = empty(wgpu::TextureDimension::D3, wgpu::TextureFormat::Rgba32Float);
        let empty_curve = empty(wgpu::TextureDimension::D2, wgpu::TextureFormat::Rgba32Float);
        let empty_overlay = empty(wgpu::TextureDimension::D2, OFFSCREEN_FORMAT);

        Ok(Renderer {
            generation: GENERATION.fetch_add(1, Ordering::Relaxed),
            fallback_only,
            instance,
            adapter,
            device,
            queue,
            lost,
            pin_layout,
            pin_shader,
            pin_pipelines: std::sync::Mutex::new(Vec::new()),
            mip_layout,
            mip_pipeline,
            empty_lut,
            empty_curve,
            empty_overlay,
        })
    }

    /// 设备丢失后整个重建。之前的图、查找表、说明层与 Surface 都要重新上传、重建。
    pub fn rebuild(&mut self) -> Result<(), Error> {
        *self = Renderer::create(self.fallback_only)?;
        Ok(())
    }

    /// 设备是否已丢失（顺便处理已完成的 GPU 工作，丢失回调在这时触发）。
    pub fn is_lost(&self) -> bool {
        let _ = self.device.poll(wgpu::PollType::Poll);
        self.lost.load(Ordering::Acquire)
    }

    /// 测试钩子：销毁设备，模拟驱动更新、远程桌面切换造成的设备丢失。
    pub fn simulate_device_loss(&self) {
        self.device.destroy();
        let _ = self.device.poll(wgpu::PollType::Poll);
    }

    /// 适配器的名称、后端与类型，写进诊断信息。
    pub fn describe(&self) -> String {
        let info = self.adapter.get_info();
        format!(
            "{}（{:?}，{:?}，驱动 {}）",
            info.name, info.backend, info.device_type, info.driver_info
        )
    }

    /// 是否是软件适配器（WARP 等）。
    pub fn is_software(&self) -> bool {
        self.adapter.get_info().device_type == wgpu::DeviceType::Cpu
    }

    /// wgpu 显存分配器的报告；后端不支持时为 `None`。
    pub fn memory(&self) -> Option<MemoryReport> {
        self.device
            .generate_allocator_report()
            .map(|r| MemoryReport {
                allocated: r.total_allocated_bytes,
                reserved: r.total_reserved_bytes,
            })
    }

    /// 等 GPU 做完已提交的工作。
    pub fn wait_idle(&self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }

    /// 在验证错误作用域里做一件事：出错时设备已丢失报 [`Error::DeviceLost`]，否则报 [`Error::Gpu`]。
    fn guarded<T>(&self, work: impl FnOnce() -> T) -> Result<T, Error> {
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let value = work();
        match block_on(scope.pop()) {
            None => Ok(value),
            Some(_) if self.is_lost() => Err(Error::DeviceLost),
            Some(e) => Err(Error::Gpu(e.to_string())),
        }
    }
}

fn pipeline(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(layout)],
        ..Default::default()
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&layout),
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
}

fn begin<'e>(
    encoder: &'e mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
) -> wgpu::RenderPass<'e> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            },
        })],
        ..Default::default()
    })
}
