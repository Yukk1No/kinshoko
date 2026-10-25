//! 上传：源图（含 GPU 上生成 mip 链）、查找表、叠加层。

use super::*;

impl Renderer {
    /// 上传一张源图，并在 GPU 上生成 mip 链。
    pub fn upload(&self, pixels: Pixels<'_>) -> Result<Image, Error> {
        let (width, height) = (pixels.width, pixels.height);
        if width == 0 || height == 0 || pixels.rgba.len() != width as usize * height as usize * 4 {
            return Err(Error::Invalid(format!(
                "{width}×{height} 的图要 {} 个分量，给了 {}",
                width as usize * height as usize * 4,
                pixels.rgba.len()
            )));
        }
        let max = self.device.limits().max_texture_dimension_2d;
        if width > max || height > max {
            return Err(Error::Invalid(format!(
                "{width}×{height} 超出纹理边长上限 {max}"
            )));
        }
        let levels = uniform::mip_levels(width, height);
        self.guarded(|| {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("pin source"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: levels,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: SOURCE_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            self.queue.write_texture(
                texture.as_image_copy(),
                bytemuck::cast_slice(pixels.rgba),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(width * 8),
                    rows_per_image: Some(height),
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
            let level_view = |level| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: level,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            };
            let mut encoder = self.device.create_command_encoder(&Default::default());
            for level in 1..levels {
                let src = level_view(level - 1);
                let dst = level_view(level);
                let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.mip_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&src),
                    }],
                });
                let mut pass = begin(&mut encoder, &dst);
                pass.set_pipeline(&self.mip_pipeline);
                pass.set_bind_group(0, &bind, &[]);
                pass.draw(0..3, 0..1);
            }
            self.queue.submit([encoder.finish()]);
            Image {
                generation: self.generation,
                view: texture.create_view(&Default::default()),
                width,
                height,
                levels,
            }
        })
    }

    /// 上传到某台显示器的查找表。
    pub fn lut(&self, data: LutData<'_>) -> Result<Lut, Error> {
        let (clut, curve, linear) = match data {
            LutData::Identity => {
                return Ok(Lut {
                    generation: self.generation,
                    tables: None,
                    bits: uniform::LUT_IDENTITY,
                });
            }
            LutData::Table {
                clut,
                curve,
                linear,
            } => (clut, curve, linear),
        };
        if clut.len() != LUT_SIZE.pow(3) * 3 || curve.len() != CURVE_SIZE * 3 {
            return Err(Error::Invalid(format!(
                "查找表要 {}＋{} 个分量，给了 {}＋{}",
                LUT_SIZE.pow(3) * 3,
                CURVE_SIZE * 3,
                clut.len(),
                curve.len()
            )));
        }
        let rgba = |rgb: &[f32]| -> Vec<f32> {
            rgb.chunks_exact(3)
                .flat_map(|c| [c[0], c[1], c[2], 1.0])
                .collect()
        };
        let n = LUT_SIZE as u32;
        self.guarded(|| {
            let clut = self.table(
                wgpu::TextureDimension::D3,
                wgpu::Extent3d {
                    width: n,
                    height: n,
                    depth_or_array_layers: n,
                },
                &rgba(clut),
            );
            let curve = self.table(
                wgpu::TextureDimension::D2,
                wgpu::Extent3d {
                    width: CURVE_SIZE as u32,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                &rgba(curve),
            );
            Lut {
                generation: self.generation,
                tables: Some((clut, curve)),
                bits: if linear { uniform::LUT_LINEAR } else { 0 },
            }
        })
    }

    fn table(
        &self,
        dimension: wgpu::TextureDimension,
        size: wgpu::Extent3d,
        rgba: &[f32],
    ) -> wgpu::TextureView {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pin lut"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            texture.as_image_copy(),
            bytemuck::cast_slice(rgba),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size.width * 16),
                rows_per_image: Some(size.height),
            },
            size,
        );
        texture.create_view(&Default::default())
    }

    /// 上传说明层：预乘 alpha 的 RGBA8（sRGB 编码）。
    pub fn overlay(&self, width: u32, height: u32, rgba: &[u8]) -> Result<Overlay, Error> {
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(Error::Invalid(format!(
                "{width}×{height} 的说明层要 {} 字节，给了 {}",
                width as usize * height as usize * 4,
                rgba.len()
            )));
        }
        self.guarded(|| {
            let size = wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            };
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("pin overlay"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: OFFSCREEN_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            self.queue.write_texture(
                texture.as_image_copy(),
                rgba,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(width * 4),
                    rows_per_image: Some(height),
                },
                size,
            );
            Overlay {
                generation: self.generation,
                view: texture.create_view(&Default::default()),
                width,
                height,
            }
        })
    }
}
