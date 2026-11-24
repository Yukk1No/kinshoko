//! 形状：小圆锁（照以前钉图层的 `.pin-veil-lock` 与 `PinView` 里的 SVG）与圆角底（`.pin-notice`）。每个像素取 4×4 个
//! 采样点算覆盖率（抗锯齿）。

use super::Part;

/// `--seal-acc`：浅色主题 #c85672，深色主题 #e3b34f。
const SEAL_LIGHT: [u8; 3] = [0xc8, 0x56, 0x72];
const SEAL_DARK: [u8; 3] = [0xe3, 0xb3, 0x4f];
/// `--on-accent`（两种主题相同）：#2b2747。
const ON_ACCENT: [u8; 3] = [0x2b, 0x27, 0x47];
const SAMPLES: u32 = 4;

/// 不透明的 sRGB 颜色（预乘即原样）。
pub(super) fn opaque(rgb: [u8; 3]) -> [f32; 4] {
    let c = |v: u8| f32::from(v) / 255.0;
    [c(rgb[0]), c(rgb[1]), c(rgb[2]), 1.0]
}

/// 每个像素里 `inside(x, y)` 为真的采样点占多少（坐标是像素坐标，可带小数）。
fn coverage(part: &mut Part, colour: [f32; 4], inside: impl Fn(f32, f32) -> bool) {
    let n = SAMPLES as f32;
    for y in 0..part.height {
        for x in 0..part.width {
            let mut hits = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let (fx, fy) = (
                        x as f32 + (sx as f32 + 0.5) / n,
                        y as f32 + (sy as f32 + 0.5) / n,
                    );
                    if inside(fx, fy) {
                        hits += 1;
                    }
                }
            }
            part.blend(x as i32, y as i32, colour, hits as f32 / (n * n));
        }
    }
}

/// 点在圆角矩形 `(x0, y0)–(x1, y1)`（圆角半径 `r`）里。
fn in_rounded(x: f32, y: f32, (x0, y0, x1, y1): (f32, f32, f32, f32), r: f32) -> bool {
    if x < x0 || y < y0 || x > x1 || y > y1 {
        return false;
    }
    let cx = x.clamp(x0 + r, x1 - r);
    let cy = y.clamp(y0 + r, y1 - r);
    (x - cx).hypot(y - cy) <= r
}

/// 小圆锁：直径 `size` 物理像素的 `--seal-acc` 圆，中间半大的锁（SVG `viewBox="0 0 14 14"`）。
pub(super) fn lock(size: u32, dark: bool) -> Part {
    let mut part = Part::new(size, size);
    let s = size as f32;
    let seal = opaque(if dark { SEAL_DARK } else { SEAL_LIGHT });
    coverage(&mut part, seal, |x, y| {
        (x - s / 2.0).hypot(y - s / 2.0) <= s / 2.0
    });
    // 图标 14 个单位占圆的一半，居中。
    let unit = s / 28.0;
    let origin = s / 4.0;
    let icon = move |x: f32, y: f32| ((x - origin) / unit, (y - origin) / unit);
    coverage(&mut part, opaque(ON_ACCENT), |x, y| {
        let (u, v) = icon(x, y);
        // 锁身：x 2.5～11.5，y 6～12.5，圆角 1.5。
        if in_rounded(u, v, (2.5, 6.0, 11.5, 12.5), 1.5) {
            return true;
        }
        // 锁梁：`M4 6V4.5a3 3 0 0 1 6 0V6`，线宽 1.6。
        let half = 0.8;
        let leg = |lx: f32| (u - lx).abs() <= half && (4.5..=6.0).contains(&v);
        let arc = v <= 4.5 && ((u - 7.0).hypot(v - 4.5) - 3.0).abs() <= half;
        leg(4.0) || leg(10.0) || arc
    });
    part
}

/// 圆角底：`width`×`height`，圆角 `radius`，预乘颜色 `colour`。
pub(super) fn rounded(width: u32, height: u32, radius: f32, colour: [f32; 4]) -> Part {
    let mut part = Part::new(width, height);
    let (w, h) = (width as f32, height as f32);
    coverage(&mut part, colour, |x, y| {
        in_rounded(x, y, (0.0, 0.0, w, h), radius)
    });
    part
}
