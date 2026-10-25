//! 绘制：窗口表面与离屏读回。

use super::*;

impl Renderer {
    /// 由平台层给的窗口目标建上屏面（预乘 alpha）。
    ///
    /// # Safety
    /// `target` 指向的平台对象（窗口、DComp visual、CAMetalLayer、wl_surface）要活得比返回的
    /// Surface 久。
    #[allow(unsafe_code)]
    pub unsafe fn surface(&self, target: wgpu::SurfaceTargetUnsafe) -> Result<Surface, Error> {
        // SAFETY: 调用方保证目标在 Surface 存活期间有效（见上）。
        let surface = unsafe { self.instance.create_surface_unsafe(target) }
            .map_err(|e| Error::Surface(e.to_string()))?;
        let caps = surface.get_capabilities(&self.adapter);
        if !caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            return Err(Error::Surface(format!(
                "不支持预乘 alpha：{:?}",
                caps.alpha_modes
            )));
        }
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .ok_or_else(|| Error::Surface(format!("没有 8 位输出格式：{:?}", caps.formats)))?;
        Ok(Surface {
            generation: self.generation,
            surface,
            config: wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                color_space: Default::default(),
                width: 1,
                height: 1,
                // 交换链只排一帧：拖动时画面不落后于窗口位置。
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 1,
                alpha_mode: wgpu::CompositeAlphaMode::PreMultiplied,
                view_formats: vec![],
            },
            configured: false,
        })
    }

    /// 把钉图画进窗口槽并 Present。窗口尺寸变了先改交换链。
    pub fn draw(
        &self,
        surface: &mut Surface,
        image: &Image,
        draw: &Draw<'_>,
        lut: &Lut,
    ) -> Result<(), Error> {
        if surface.generation != self.generation {
            return Err(Error::Stale);
        }
        let bind = self.bind(image, draw, lut)?;
        let (width, height) = (draw.window.width.max(1), draw.window.height.max(1));
        if !surface.configured || surface.config.width != width || surface.config.height != height {
            surface.config.width = width;
            surface.config.height = height;
            surface.surface.configure(&self.device, &surface.config);
            surface.configured = true;
        }
        let frame = match surface.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                // 交换链过期（例如窗口刚被平台层改过）：重新配置后再取一次。
                surface.surface.configure(&self.device, &surface.config);
                match surface.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    other => return Err(self.surface_error(other)),
                }
            }
            other => return Err(self.surface_error(other)),
        };
        let target = frame.texture.create_view(&Default::default());
        self.guarded(|| self.render(&target, surface.config.format, &bind))?;
        self.queue.present(frame);
        Ok(())
    }

    fn surface_error(&self, state: wgpu::CurrentSurfaceTexture) -> Error {
        if self.is_lost() {
            Error::DeviceLost
        } else {
            Error::Surface(format!("取不到后台缓冲：{state:?}"))
        }
    }

    /// 离屏画一帧并读回（测试与门槛实验用）。尺寸是 `draw.window` 的尺寸，结果与窗口里的画面相同：
    /// 预乘 alpha、显示器编码。
    pub fn render_offscreen(
        &self,
        image: &Image,
        draw: &Draw<'_>,
        lut: &Lut,
    ) -> Result<RgbaImage, Error> {
        let bind = self.bind(image, draw, lut)?;
        let (width, height) = (draw.window.width.max(1), draw.window.height.max(1));
        let row = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = self.guarded(|| {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("pin offscreen"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: OFFSCREEN_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            self.render(
                &texture.create_view(&Default::default()),
                OFFSCREEN_FORMAT,
                &bind,
            );
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("pin readback"),
                size: u64::from(row) * u64::from(height),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let mut encoder = self.device.create_command_encoder(&Default::default());
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(row),
                        rows_per_image: Some(height),
                    },
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
            self.queue.submit([encoder.finish()]);
            buffer
        })?;
        let (tx, rx) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |r| drop(tx.send(r)));
        self.wait_idle();
        match rx.try_recv() {
            Ok(Ok(())) => {}
            _ if self.is_lost() => return Err(Error::DeviceLost),
            Ok(Err(e)) => return Err(Error::Gpu(format!("读回失败：{e}"))),
            Err(_) => return Err(Error::Gpu("读回没有完成".into())),
        }
        let mapped = buffer
            .slice(..)
            .get_mapped_range()
            .map_err(|e| Error::Gpu(format!("读回失败：{e}")))?;
        let mut data = Vec::with_capacity(width as usize * height as usize * 4);
        for y in 0..height as usize {
            let start = y * row as usize;
            data.extend_from_slice(&mapped[start..start + width as usize * 4]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(RgbaImage {
            width,
            height,
            data,
        })
    }

    /// 核对句柄、打包统一变量，建绑定组。
    fn bind(&self, image: &Image, draw: &Draw<'_>, lut: &Lut) -> Result<wgpu::BindGroup, Error> {
        let overlay = draw.overlay.map(|(o, _)| o);
        if image.generation != self.generation
            || lut.generation != self.generation
            || overlay.is_some_and(|o| o.generation != self.generation)
        {
            return Err(Error::Stale);
        }
        if self.is_lost() {
            return Err(Error::DeviceLost);
        }
        let packed: PinUniform = uniform::pack(
            draw,
            Source {
                width: image.width,
                height: image.height,
                levels: image.levels,
            },
            overlay.map(|o| (o.width, o.height)),
            lut.bits,
        );
        self.guarded(|| {
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("pin uniform"),
                size: std::mem::size_of::<PinUniform>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.queue
                .write_buffer(&buffer, 0, bytemuck::bytes_of(&packed));
            let (clut, curve) = match &lut.tables {
                Some((clut, curve)) => (clut, curve),
                None => (&self.empty_lut, &self.empty_curve),
            };
            let view = |binding, view| wgpu::BindGroupEntry {
                binding,
                resource: wgpu::BindingResource::TextureView(view),
            };
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pin"),
                layout: &self.pin_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    },
                    view(1, &image.view),
                    view(2, clut),
                    view(3, curve),
                    view(4, overlay.map_or(&self.empty_overlay, |o| &o.view)),
                ],
            })
        })
    }

    fn render(
        &self,
        target: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        bind: &wgpu::BindGroup,
    ) {
        let pipeline = {
            let mut pipelines = self.pin_pipelines.lock().unwrap_or_else(|e| e.into_inner());
            match pipelines.iter().find(|(f, _)| *f == format) {
                Some((_, p)) => p.clone(),
                None => {
                    let p = pipeline(&self.device, &self.pin_layout, &self.pin_shader, format);
                    pipelines.push((format, p.clone()));
                    p
                }
            }
        };
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = begin(&mut encoder, target);
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, bind, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
    }
}
