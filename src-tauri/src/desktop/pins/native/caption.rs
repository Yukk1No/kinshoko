//! 说明层（#285）：遮蔽时的小圆锁、读不到图时的原因文字（#66）、菜单动作后的提示。在 CPU 上画成
//! 一张预乘 alpha 的 sRGB 小图，渲染层按 1:1 画在钉图最上面（`pin_render::Draw::overlay`）。
//!
//! 样子照钉图层的 `desktop.css`（`.pin-veil-lock`、`.pin-missing`、`.pin-notice`），尺寸是 CSS 像素，
//! 按显示器缩放比例换成物理像素。字用 cosmic-text 排（系统字体），不调平台文字 API。
//!
//! 各部分（[`Part`]）按缩放比例与文字缓存；内容尺寸变了（缩放动画）只重新摆放、合成，不重新排字
//! （原因文字按内容宽度换行，宽度变了才重排）。

mod shape;
mod text;

use std::collections::HashMap;

/// 一次绘制要画的说明。
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Caption {
    /// 遮蔽着：中间一枚小圆锁（点它确认显示）。
    pub lock: bool,
    /// 读不到图：中间写出原因。
    pub reason: Option<String>,
    /// 底部的一条提示（“已锁定”“已复制”……），1.6 秒后消失。
    pub notice: Option<String>,
}

impl Caption {
    pub fn is_empty(&self) -> bool {
        !self.lock && self.reason.is_none() && self.notice.is_none()
    }
}

/// 画好的说明层：左上角相对内容左上角的位置，与预乘 alpha 的 RGBA8（sRGB）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Painted {
    pub at: (i32, i32),
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// 一部分：预乘 RGBA8 的小图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Part {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Part {
    pub fn new(width: u32, height: u32) -> Part {
        Part {
            width,
            height,
            rgba: vec![0; (width * height * 4) as usize],
        }
    }

    /// 把预乘的 `colour` 按覆盖率 `cover` 盖在 (x, y) 上。
    pub fn blend(&mut self, x: i32, y: i32, colour: [f32; 4], cover: f32) {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 || cover <= 0.0 {
            return;
        }
        let i = ((y as u32 * self.width + x as u32) * 4) as usize;
        let k = cover.min(1.0);
        let a = colour[3] * k;
        for (c, (out, top)) in self.rgba[i..i + 4].iter_mut().zip(colour).enumerate() {
            let top = if c == 3 { a } else { top * k };
            let bottom = f32::from(*out) / 255.0;
            *out = ((top + bottom * (1.0 - a)) * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }

    /// 把 `other` 盖在 (x, y) 上（都是预乘）。
    fn paste(&mut self, other: &Part, x: i32, y: i32) {
        for py in 0..other.height {
            for px in 0..other.width {
                let i = ((py * other.width + px) * 4) as usize;
                let p = &other.rgba[i..i + 4];
                if p[3] == 0 {
                    continue;
                }
                let colour = [p[0], p[1], p[2], p[3]].map(|v| f32::from(v) / 255.0);
                self.blend(x + px as i32, y + py as i32, colour, 1.0);
            }
        }
    }
}

/// CSS 像素 → 物理像素（取整，至少 1）。
fn px(css: f64, scale: f64) -> u32 {
    (css * scale).round().max(1.0) as u32
}

/// 画说明层。字体在第一次要写字时才读（读系统字体要一会儿，只在渲染线程上）。
#[derive(Default)]
pub struct Painter {
    text: Option<text::Typesetter>,
    locks: HashMap<(u32, bool), Part>,
    reasons: HashMap<(String, u32, u32), Part>,
    notices: HashMap<(String, u32, u32), Part>,
}

impl Painter {
    /// `content`：内容此刻的物理像素尺寸；`scale`：显示器缩放比例；`dark`：深色主题（小圆锁的颜色
    /// 不同）。没有要画的时为 `None`。
    pub fn paint(
        &mut self,
        caption: &Caption,
        content: (u32, u32),
        scale: f64,
        dark: bool,
    ) -> Option<Painted> {
        if caption.is_empty() {
            return None;
        }
        let (w, h) = (content.0 as i32, content.1 as i32);
        let key = (scale * 1000.0).round() as u32;
        let mut parts: Vec<(&Part, i32, i32)> = Vec::new();
        // 文字的缓存可能要改：先把要的都做好，再借出来摆放。
        if let Some(reason) = &caption.reason {
            // `.pin-missing`：四周留 8 px，居中换行。
            let wrap = (content.0 as i64 - i64::from(px(16.0, scale))).max(1) as u32;
            let k = (reason.clone(), wrap, key);
            if !self.reasons.contains_key(&k) {
                let part = self.typesetter().reason(reason, wrap, scale);
                self.reasons.insert(k.clone(), part);
            }
        }
        if let Some(notice) = &caption.notice {
            // `.pin-notice`：最宽为内容宽度减 12 px，单行，放不下时省略。
            let max = (content.0 as i64 - i64::from(px(12.0, scale))).max(1) as u32;
            let k = (notice.clone(), max, key);
            if !self.notices.contains_key(&k) {
                let part = self.typesetter().notice(notice, max, scale);
                self.notices.insert(k.clone(), part);
            }
        }
        if let Some(reason) = &caption.reason {
            let wrap = (content.0 as i64 - i64::from(px(16.0, scale))).max(1) as u32;
            let part = &self.reasons[&(reason.clone(), wrap, key)];
            parts.push((
                part,
                (w - part.width as i32) / 2,
                (h - part.height as i32) / 2,
            ));
        }
        if caption.lock {
            let part = self
                .locks
                .entry((key, dark))
                .or_insert_with(|| shape::lock(px(28.0, scale), dark));
            parts.push((
                part,
                (w - part.width as i32) / 2,
                (h - part.height as i32) / 2,
            ));
        }
        if let Some(notice) = &caption.notice {
            let max = (content.0 as i64 - i64::from(px(12.0, scale))).max(1) as u32;
            let part = &self.notices[&(notice.clone(), max, key)];
            let bottom = px(6.0, scale) as i32;
            parts.push((
                part,
                (w - part.width as i32) / 2,
                h - bottom - part.height as i32,
            ));
        }
        Some(compose(&parts))
    }

    fn typesetter(&mut self) -> &mut text::Typesetter {
        self.text.get_or_insert_with(text::Typesetter::new)
    }
}

/// 各部分合成一张：大小是它们的并集。
fn compose(parts: &[(&Part, i32, i32)]) -> Painted {
    let left = parts.iter().map(|(_, x, _)| *x).min().unwrap_or(0);
    let top = parts.iter().map(|(_, _, y)| *y).min().unwrap_or(0);
    let right = parts
        .iter()
        .map(|(p, x, _)| x + p.width as i32)
        .max()
        .unwrap_or(0);
    let bottom = parts
        .iter()
        .map(|(p, _, y)| y + p.height as i32)
        .max()
        .unwrap_or(0);
    let mut canvas = Part::new((right - left).max(1) as u32, (bottom - top).max(1) as u32);
    for (part, x, y) in parts {
        canvas.paste(part, x - left, y - top);
    }
    Painted {
        at: (left, top),
        width: canvas.width,
        height: canvas.height,
        rgba: canvas.rgba,
    }
}

#[cfg(test)]
mod tests;
