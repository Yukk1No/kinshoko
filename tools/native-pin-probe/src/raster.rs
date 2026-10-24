//! 把源图按钉图此刻的局部、缩放、翻转、旋转画进窗口位图，四周画一圈常驻阴影。
//!
//! 窗口 = 显示尺寸四周各扩 [`PIN_EDGE`]；窗口可能被裁到屏幕范围内（放得很大时），所以只画
//! 可见的那块 `vis`。先在未旋转的坐标里缩出要的那块，再按旋转、翻转逐像素搬进窗口位图。

use fast_image_resize::{self as fr, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

use crate::source::Source;

pub const PIN_EDGE: i32 = kinshoko_core::desktop::PIN_EDGE as i32;

#[derive(Clone, Copy, Debug)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct View {
    /// 原图像素 → 物理像素。
    pub scale: f64,
    /// 顺时针四分之一圈数。
    pub rotation: u8,
    pub flip_h: bool,
    pub flip_v: bool,
    /// 局部（原图像素）；`None` 为整图。
    pub crop: Option<Crop>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    /// 手势中：金字塔里不小于目标的一层，三角滤波；放大用 Catmull-Rom。
    Gesture,
    /// 停手后：第 0 层，线性光（sRGB 曲线近似）Lanczos3。
    Settled,
    /// 放大时按像素（最近邻）。
    Nearest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        let r = self.right().min(o.right());
        let b = self.bottom().min(o.bottom());
        (r > x && b > y).then_some(Rect {
            x,
            y,
            w: r - x,
            h: b - y,
        })
    }
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.right() && py < self.bottom()
    }
}

impl View {
    pub fn crop_rect(&self, src: &Source) -> Crop {
        self.crop.unwrap_or(Crop {
            x: 0.0,
            y: 0.0,
            w: src.width() as f64,
            h: src.height() as f64,
        })
    }
    /// 未旋转的内容尺寸（物理像素）。
    pub fn content_size(&self, src: &Source) -> (i32, i32) {
        let c = self.crop_rect(src);
        (
            ((c.w * self.scale).round() as i32).max(1),
            ((c.h * self.scale).round() as i32).max(1),
        )
    }
    /// 旋转后的显示尺寸。
    pub fn display_size(&self, src: &Source) -> (i32, i32) {
        let (w, h) = self.content_size(src);
        if self.rotation % 2 == 1 {
            (h, w)
        } else {
            (w, h)
        }
    }
    /// 显示坐标（相对内容左上角的像素下标）→ 未旋转、未翻转的内容坐标。
    fn to_content(&self, x: i32, y: i32, cw: i32, ch: i32) -> (i32, i32) {
        let (mut u, mut v) = match self.rotation % 4 {
            0 => (x, y),
            1 => (y, ch - 1 - x),
            2 => (cw - 1 - x, ch - 1 - y),
            _ => (cw - 1 - y, x),
        };
        if self.flip_h {
            u = cw - 1 - u;
        }
        if self.flip_v {
            v = ch - 1 - v;
        }
        (u, v)
    }
}

/// 各步耗时（微秒），给测量用。
#[derive(Default, Clone, Copy, Debug)]
pub struct RenderTimes {
    pub resample_us: u64,
    pub blit_us: u64,
    pub shadow_us: u64,
    pub level: usize,
    /// 缩出来的像素是上一帧的（只换了旋转、翻转）。
    pub cached: bool,
}

pub struct Rasterizer {
    resizer: Resizer,
    scratch: fr::images::Image<'static>,
    strips: Strips,
    srgb: fr::PixelComponentMapper,
    /// 精缩时源层至少是目标的几倍；`f64::INFINITY` 为总从第 0 层缩。
    pub oversample: f64,
    /// 手势帧用两点插值（不做卷积），更快、略有混叠。
    pub gesture_interp: bool,
    cache_key: Option<(usize, usize, String, [u64; 4], u32, u32)>,
}

/// 线性光分条缩放的缓冲，跨帧复用。
#[derive(Default)]
pub struct Strips {
    region: Vec<u8>,
    linear: Vec<u16>,
    out16: Vec<u16>,
}

/// 输出每条多少行。分条只为限制缓冲大小：16 位线性光整块转换一张 4000×6000 要 192 MB。
const STRIP_ROWS: u32 = 96;

/// 在线性光（sRGB 曲线近似，16 位）里把 `level` 的 `crop` 区域缩到 `dw`×`dh`，写进 `dst`（BGRA8）。
/// 按输出分条：每条只把它要读的源行（含卷积支撑）转到线性光。分条与整块的结果相同，因为 fast_image_resize
/// 的裁切框外仍读真实像素，每条的裁切框又按同一个比例从整块里切出来。
#[allow(clippy::too_many_arguments)]
pub fn linear_resize(
    resizer: &mut Resizer,
    srgb: &fr::PixelComponentMapper,
    bufs: &mut Strips,
    level: &crate::source::Level,
    crop: (f64, f64, f64, f64),
    dst: &mut [u8],
    dw: u32,
    dh: u32,
    alg: ResizeAlg,
) {
    let (left, top, width, height) = crop;
    let ky = height / dh as f64;
    let kx = width / dw as f64;
    // Lanczos3 的支撑是 3 个目标像素，换成源像素再多带两行。
    let pad_y = (3.0 * ky.max(1.0)).ceil() as u32 + 2;
    let pad_x = (3.0 * kx.max(1.0)).ceil() as u32 + 2;
    let px0 = (left.floor() as u32).saturating_sub(pad_x);
    let px1 = (((left + width).ceil() as u32) + pad_x).min(level.width);
    let pw = px1 - px0;
    let mut r0 = 0;
    while r0 < dh {
        let r1 = (r0 + STRIP_ROWS).min(dh);
        let st = top + r0 as f64 * ky;
        let sh = (r1 - r0) as f64 * ky;
        let py0 = (st.floor() as u32).saturating_sub(pad_y);
        let py1 = (((st + sh).ceil() as u32) + pad_y).min(level.height);
        let ph = py1 - py0;
        bufs.region.resize((pw * ph * 4) as usize, 0);
        for row in 0..ph {
            let s = (((py0 + row) * level.width + px0) * 4) as usize;
            let d = (row * pw * 4) as usize;
            bufs.region[d..d + (pw * 4) as usize]
                .copy_from_slice(&level.px[s..s + (pw * 4) as usize]);
        }
        bufs.linear.resize((pw * ph * 4) as usize, 0);
        bufs.out16.resize((dw * (r1 - r0) * 4) as usize, 0);
        let region = fr::images::ImageRef::new(pw, ph, &bufs.region, PixelType::U8x4).unwrap();
        let mut linear = fr::images::Image::from_slice_u8(
            pw,
            ph,
            bytemuck_u16(&mut bufs.linear),
            PixelType::U16x4,
        )
        .unwrap();
        srgb.forward_map(&region, &mut linear).expect("映射");
        let mut out16 = fr::images::Image::from_slice_u8(
            dw,
            r1 - r0,
            bytemuck_u16(&mut bufs.out16),
            PixelType::U16x4,
        )
        .unwrap();
        let options = ResizeOptions::new()
            .resize_alg(alg)
            .crop(left - px0 as f64, st - py0 as f64, width, sh)
            .use_alpha(false);
        resizer.resize(&linear, &mut out16, &options).expect("缩放");
        let rows = &mut dst[(r0 * dw * 4) as usize..(r1 * dw * 4) as usize];
        let mut out8 =
            fr::images::Image::from_slice_u8(dw, r1 - r0, rows, PixelType::U8x4).unwrap();
        srgb.backward_map(&out16, &mut out8).expect("映射");
        r0 = r1;
    }
}

fn bytemuck_u16(v: &mut [u16]) -> &mut [u8] {
    // u16 切片按字节看：对齐只会更宽松，长度乘 2。
    unsafe { std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, v.len() * 2) }
}

impl Rasterizer {
    pub fn new() -> Self {
        Self {
            resizer: Resizer::new(),
            scratch: fr::images::Image::new(1, 1, PixelType::U8x4),
            strips: Strips::default(),
            oversample: 2.0,
            gesture_interp: false,
            cache_key: None,
            srgb: fr::create_srgb_mapper(),
        }
    }

    /// 画窗口的可见部分 `vis`（窗口坐标）到 `out`（行距 `stride` 字节，预乘 BGRA）。
    pub fn render(
        &mut self,
        src: &Source,
        view: &View,
        quality: Quality,
        vis: Rect,
        out: &mut [u8],
        stride: usize,
    ) -> RenderTimes {
        let mut times = RenderTimes::default();
        let (cw, ch) = view.content_size(src);
        let (dw, dh) = view.display_size(src);
        let content = Rect {
            x: PIN_EDGE,
            y: PIN_EDGE,
            w: dw,
            h: dh,
        };

        // 1. 阴影：整块可见区域先铺阴影，内容再盖上去。
        let t = std::time::Instant::now();
        shadow(out, stride, vis, content);
        times.shadow_us = t.elapsed().as_micros() as u64;

        let Some(d) = vis.intersect(&content) else {
            return times;
        };
        // 显示坐标（相对内容）里的可见块 → 未旋转内容坐标里的块 U。
        let (dx0, dy0) = (d.x - PIN_EDGE, d.y - PIN_EDGE);
        let (dx1, dy1) = (dx0 + d.w - 1, dy0 + d.h - 1);
        let (u0, v0) = view.to_content(dx0, dy0, cw, ch);
        let (u1, v1) = view.to_content(dx1, dy1, cw, ch);
        let u = Rect {
            x: u0.min(u1),
            y: v0.min(v1),
            w: (u0 - u1).abs() + 1,
            h: (v0 - v1).abs() + 1,
        };

        // 2. 缩出 U。
        let t = std::time::Instant::now();
        let crop = view.crop_rect(src);
        let scale = view.scale;
        let exact = (scale - 1.0).abs() < 1e-9;
        let (level_index, alg, linear) = match quality {
            _ if exact => (0, ResizeAlg::Nearest, false),
            Quality::Nearest if scale > 1.0 => (0, ResizeAlg::Nearest, false),
            _ if scale >= 1.0 => (0, ResizeAlg::Convolution(FilterType::CatmullRom), false),
            Quality::Settled => {
                // 不小于目标 2 倍的最小一层（金字塔本身在线性光里做）：比从第 0 层缩快几倍，差别见报告。
                let mut l = 0;
                while l + 1 < src.levels.len()
                    && (src.levels[l + 1].width as f64 / src.width() as f64)
                        >= scale * self.oversample
                {
                    l += 1;
                }
                (l, ResizeAlg::Convolution(FilterType::Lanczos3), true)
            }
            _ => {
                // 不小于目标的最小一层。
                let mut l = 0;
                while l + 1 < src.levels.len()
                    && (src.levels[l + 1].width as f64 / src.width() as f64) >= scale
                {
                    l += 1;
                }
                let alg = if self.gesture_interp {
                    ResizeAlg::Interpolation(FilterType::Bilinear)
                } else {
                    ResizeAlg::Convolution(FilterType::Bilinear)
                };
                (l, alg, false)
            }
        };
        times.level = level_index;
        let level = &src.levels[level_index];
        let fx = level.width as f64 / src.width() as f64;
        let fy = level.height as f64 / src.height() as f64;
        let left = ((crop.x + u.x as f64 / scale) * fx).clamp(0.0, level.width as f64);
        let top = ((crop.y + u.y as f64 / scale) * fy).clamp(0.0, level.height as f64);
        let width = (u.w as f64 / scale * fx)
            .min(level.width as f64 - left)
            .max(1e-3);
        let height = (u.h as f64 / scale * fy)
            .min(level.height as f64 - top)
            .max(1e-3);
        let src_img =
            fr::images::ImageRef::new(level.width, level.height, &level.px, PixelType::U8x4)
                .expect("金字塔层尺寸正确");
        let options = ResizeOptions::new()
            .resize_alg(alg)
            .crop(left, top, width, height)
            .use_alpha(false);
        let (uw, uh) = (u.w as u32, u.h as u32);
        // 只换旋转、翻转时缩出来的像素不变：直接重搬，不重缩（同一张源图、同一块、同一种缩法）。
        let key = (
            src as *const Source as usize,
            level_index,
            format!("{alg:?}"),
            [left, top, width, height].map(f64::to_bits),
            uw,
            uh,
        );
        let cached = self.cache_key.as_ref() == Some(&key);
        times.cached = cached;
        if !cached {
            if self.scratch.width() != uw || self.scratch.height() != uh {
                self.scratch = fr::images::Image::new(uw, uh, PixelType::U8x4);
            }
            if linear {
                let dst = self.scratch.buffer_mut();
                linear_resize(
                    &mut self.resizer,
                    &self.srgb,
                    &mut self.strips,
                    level,
                    (left, top, width, height),
                    dst,
                    uw,
                    uh,
                    alg,
                );
            } else {
                self.resizer
                    .resize(&src_img, &mut self.scratch, &options)
                    .expect("缩放");
            }
        }
        self.cache_key = Some(key);
        times.resample_us = t.elapsed().as_micros() as u64;

        // 3. 按旋转、翻转搬进窗口位图。
        let t = std::time::Instant::now();
        let s = self.scratch.buffer();
        let min_alpha = !src.opaque;
        let identity = view.rotation % 4 == 0 && !view.flip_h && !view.flip_v;
        use rayon::prelude::*;
        let first = (d.y - vis.y) as usize * stride;
        let rows = &mut out[first..first + d.h as usize * stride];
        rows.par_chunks_mut(stride)
            .enumerate()
            .for_each(|(y, line)| {
                let y = y as i32;
                let x0 = ((d.x - vis.x) as usize) * 4;
                let dst = &mut line[x0..x0 + d.w as usize * 4];
                if identity {
                    let srow = ((dy0 + y - u.y) as usize * uw as usize + (dx0 - u.x) as usize) * 4;
                    dst.copy_from_slice(&s[srow..srow + d.w as usize * 4]);
                } else {
                    // 一行里相邻显示像素在内容里的步进是常数。
                    let (a0, b0) = view.to_content(dx0, dy0 + y, cw, ch);
                    let (a1, b1) = view.to_content(dx0 + 1, dy0 + y, cw, ch);
                    let (su, sv) = (a1 - a0, b1 - b0);
                    let (mut cu, mut cv) = (a0 - u.x, b0 - u.y);
                    for px in dst.chunks_exact_mut(4) {
                        let i = (cv as usize * uw as usize + cu as usize) * 4;
                        px.copy_from_slice(&s[i..i + 4]);
                        cu += su;
                        cv += sv;
                    }
                }
                if min_alpha {
                    // 全透明的像素点不中窗口；钉图上任何地方都要接点击，最低给 1/255。
                    for px in dst.chunks_exact_mut(4) {
                        if px[3] == 0 {
                            px[3] = 1;
                        }
                    }
                }
            });
        times.blit_us = t.elapsed().as_micros() as u64;
        times
    }
}

/// 两层投影与 `src/desktop/pin-edge.css` 相同：`0 2px 5px rgba(0,0,0,.3)` 与 `0 0 3px rgba(0,0,0,.28)`
/// （PIN_EDGE = 8 时）。CSS 模糊半径 B 对应高斯 σ = B/2；矩形的高斯模糊可分离成两个一维积分。
fn shadow(out: &mut [u8], stride: usize, vis: Rect, content: Rect) {
    let e = PIN_EDGE as f32;
    let near = (0.3f32, e * 0.25, e * 0.625 / 2.0);
    let far = (0.28f32, 0.0f32, e * 0.375 / 2.0);
    let g = |t: f32, a: f32, b: f32, sigma: f32| phi((t - a) / sigma) - phi((t - b) / sigma);
    let cols: Vec<(f32, f32)> = (vis.x..vis.right())
        .map(|x| {
            let t = x as f32 + 0.5;
            let (l, r) = (content.x as f32, content.right() as f32);
            (g(t, l, r, near.2), g(t, l, r, far.2))
        })
        .collect();
    for y in vis.y..vis.bottom() {
        let t = y as f32 + 0.5;
        let (top, bot) = (content.y as f32, content.bottom() as f32);
        let gn = g(t, top + near.1, bot + near.1, near.2);
        let gf = g(t, top, bot, far.2);
        let row = ((y - vis.y) as usize) * stride;
        let inside_row = y >= content.y && y < content.bottom();
        let n = cols.len() as i32;
        // 内容所在的行只画左右两段。
        let (skip0, skip1) = if inside_row {
            (
                (content.x - vis.x).clamp(0, n),
                (content.right() - vis.x).clamp(0, n),
            )
        } else {
            (n, n)
        };
        for i in (0..skip0).chain(skip1..n) {
            let (cn, cf) = cols[i as usize];
            let a1 = near.0 * gn * cn;
            let a2 = far.0 * gf * cf;
            let a = 1.0 - (1.0 - a1) * (1.0 - a2);
            // 阴影外沿接近 0：最低 1/255，整圈都接点击。
            let a = ((a * 255.0).round() as u8).max(1);
            let p = row + i as usize * 4;
            out[p..p + 4].copy_from_slice(&[0, 0, 0, a]);
        }
    }
}

/// 标准正态分布函数（Abramowitz–Stegun 7.1.26 的 erf 近似）。
fn phi(x: f32) -> f32 {
    let z = x / std::f32::consts::SQRT_2;
    let t = 1.0 / (1.0 + 0.3275911 * z.abs());
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496735) * t
            + 0.254829592)
            * t
            * (-z * z).exp();
    0.5 * (1.0 + if z >= 0.0 { y } else { -y })
}
