//! 排字：cosmic-text 读系统字体（中文按它的后备字体表找），swash 光栅化。字号 12 CSS 像素，白字
//! （`--on-solid`）。

use cosmic_text::{
    Align, Attrs, Buffer, Color, Ellipsize, EllipsizeHeightLimit, FontSystem, Metrics, Shaping,
    SwashCache, Wrap,
};

use super::shape::rounded;
use super::{Part, px};

/// 字号与行高，CSS 像素。
const FONT: f32 = 12.0;
const LINE: f32 = 16.0;
/// `--scrim-label`：黑色 60%。
const SCRIM: [f32; 4] = [0.0, 0.0, 0.0, 0.6];

pub(super) struct Typesetter {
    fonts: FontSystem,
    swash: SwashCache,
}

/// 排好的一段字：每个像素的覆盖率，与尺寸。
struct Laid {
    width: u32,
    height: u32,
    cover: Vec<f32>,
}

impl Typesetter {
    pub fn new() -> Typesetter {
        Typesetter {
            fonts: FontSystem::new(),
            swash: SwashCache::new(),
        }
    }

    /// 读不到图的原因：最宽 `wrap` 物理像素，按词换行，居中。
    pub fn reason(&mut self, text: &str, wrap: u32, scale: f64) -> Part {
        let laid = self.lay(text, Some(wrap), Wrap::WordOrGlyph, Ellipsize::None, scale);
        let mut part = Part::new(laid.width, laid.height);
        ink(&mut part, &laid, 0, 0);
        part
    }

    /// 提示：一行，最宽 `max` 物理像素（含左右 8 px 留白），放不下时末尾省略；黑色 60% 圆角底。
    pub fn notice(&mut self, text: &str, max: u32, scale: f64) -> Part {
        let (pad_x, pad_y) = (px(8.0, scale), px(2.0, scale));
        let room = max.saturating_sub(2 * pad_x).max(1);
        let laid = self.lay(
            text,
            Some(room),
            Wrap::None,
            Ellipsize::End(EllipsizeHeightLimit::Lines(1)),
            scale,
        );
        let mut part = rounded(
            laid.width + 2 * pad_x,
            laid.height + 2 * pad_y,
            4.0 * scale as f32,
            SCRIM,
        );
        ink(&mut part, &laid, pad_x as i32, pad_y as i32);
        part
    }

    fn lay(
        &mut self,
        text: &str,
        width: Option<u32>,
        wrap: Wrap,
        ellipsize: Ellipsize,
        scale: f64,
    ) -> Laid {
        let metrics = Metrics::new(FONT * scale as f32, LINE * scale as f32);
        let mut buffer = Buffer::new(&mut self.fonts, metrics);
        let mut b = buffer.borrow_with(&mut self.fonts);
        b.set_wrap(wrap);
        b.set_ellipsize(ellipsize);
        b.set_size(width.map(|w| w as f32), None);
        b.set_text(text, &Attrs::new(), Shaping::Advanced, Some(Align::Center));
        // 实际用到的宽度：最长的一行；居中对齐是在 `width` 里居中，要减去左边空出的那段。
        let (mut left, mut right, mut lines) = (f32::MAX, 0.0f32, 0);
        for run in b.layout_runs() {
            lines += 1;
            if let (Some(first), Some(last)) = (run.glyphs.first(), run.glyphs.last()) {
                left = left.min(first.x);
                right = right.max(last.x + last.w);
            }
        }
        if lines == 0 || left > right {
            return Laid {
                width: 1,
                height: 1,
                cover: vec![0.0],
            };
        }
        let (x0, width) = (
            left.floor() as i32,
            (right.ceil() - left.floor()).max(1.0) as u32,
        );
        let height = ((lines as f32) * metrics.line_height).ceil().max(1.0) as u32;
        let mut cover = vec![0.0f32; (width * height) as usize];
        b.draw(
            &mut self.swash,
            Color::rgb(255, 255, 255),
            |x, y, w, h, c| {
                let a = f32::from(c.a()) / 255.0;
                for py in y..y + h as i32 {
                    for px in x - x0..x - x0 + w as i32 {
                        if px >= 0 && py >= 0 && (px as u32) < width && (py as u32) < height {
                            let i = (py as u32 * width + px as u32) as usize;
                            cover[i] = (cover[i] + a * (1.0 - cover[i])).min(1.0);
                        }
                    }
                }
            },
        );
        Laid {
            width,
            height,
            cover,
        }
    }
}

/// 白字按覆盖率盖在 `part` 的 (x, y) 处。
fn ink(part: &mut Part, laid: &Laid, x: i32, y: i32) {
    for py in 0..laid.height {
        for px in 0..laid.width {
            let c = laid.cover[(py * laid.width + px) as usize];
            part.blend(x + px as i32, y + py as i32, [1.0; 4], c);
        }
    }
}
