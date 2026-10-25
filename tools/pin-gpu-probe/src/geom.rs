//! 几何（正式方案放进 `kinshoko-core`，纯函数、可单测）：钉图的摆放、以光标为中心缩放、绕中心旋转，
//! 以及本原型的关键规则——**每一帧怎么上屏**（[`plan`]）。
//!
//! 规则只有一条：看得见的窗口只许平移，不许改尺寸。
//! - 内容在窗口里放得下：只重画内容（一次 Present，内容自己就是原子的）。
//! - 内容和窗口一起平移、像素不变：只挪窗口（窗口里的合成内容跟着窗口走）。
//! - 其余情况：在看不见的备用窗口上改好尺寸、画好，再一次提交把它换上来（[`Step::Swap`]）。
//!   手势中换上来的窗口比钉图大一圈（[`envelope`]），之后的若干格都只需重画；停手再收成钉图大小。

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }
    pub fn area(&self) -> i64 {
        i64::from(self.w.max(0)) * i64::from(self.h.max(0))
    }
    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = self.right().min(o.right());
        let y1 = self.bottom().min(o.bottom());
        (x1 > x0 && y1 > y0).then(|| Rect::new(x0, y0, x1 - x0, y1 - y0))
    }
    pub fn union(&self, o: &Rect) -> Rect {
        let x0 = self.x.min(o.x);
        let y0 = self.y.min(o.y);
        let x1 = self.right().max(o.right());
        let y1 = self.bottom().max(o.bottom());
        Rect::new(x0, y0, x1 - x0, y1 - y0)
    }
    pub fn contains(&self, o: &Rect) -> bool {
        o.x >= self.x && o.y >= self.y && o.right() <= self.right() && o.bottom() <= self.bottom()
    }
    pub fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.right() && y < self.bottom()
    }
    pub fn expand(&self, e: i32) -> Rect {
        Rect::new(self.x - e, self.y - e, self.w + 2 * e, self.h + 2 * e)
    }
    pub fn same_size(&self, o: &Rect) -> bool {
        self.w == o.w && self.h == o.h
    }
}

/// 钉图四周阴影那一圈（与 `kinshoko-core` 的 `PIN_EDGE` 相同）。
pub const PIN_EDGE: i32 = 8;
pub const MIN_SCALE: f64 = 0.02;
pub const MAX_SCALE: f64 = 10.0;

/// 钉图怎么摆：源图（裁切后）尺寸、内容左上角（物理像素，小数，缩放锚点不漂移）、缩放、旋转、翻转、透明度。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub src_w: u32,
    pub src_h: u32,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    /// 顺时针四分之一圈数。
    pub rotation: u8,
    pub flip_h: bool,
    pub flip_v: bool,
    pub opacity: f32,
}

impl View {
    /// 旋转后、缩放后的内容尺寸（小数）。
    pub fn size(&self) -> (f64, f64) {
        let (w, h) = if self.rotation % 2 == 1 {
            (self.src_h, self.src_w)
        } else {
            (self.src_w, self.src_h)
        };
        (f64::from(w) * self.scale, f64::from(h) * self.scale)
    }

    /// 内容在屏幕上的矩形，取整到物理像素（两边各自取整，相邻状态不会差出一像素的抖动）。
    pub fn content(&self) -> Rect {
        let (w, h) = self.size();
        let x0 = self.x.round() as i32;
        let y0 = self.y.round() as i32;
        let x1 = (self.x + w).round() as i32;
        let y1 = (self.y + h).round() as i32;
        Rect::new(x0, y0, (x1 - x0).max(1), (y1 - y0).max(1))
    }

    /// 以屏幕上的 (cx, cy) 为中心缩放 `factor` 倍：那一点下的图片像素不动。
    pub fn zoom_at(&mut self, cx: f64, cy: f64, factor: f64) {
        let to = (self.scale * factor).clamp(MIN_SCALE, MAX_SCALE);
        let k = to / self.scale;
        self.x = cx - (cx - self.x) * k;
        self.y = cy - (cy - self.y) * k;
        self.scale = to;
    }

    /// 顺时针转 90°，绕内容中心。
    pub fn rotate_cw(&mut self) {
        let (w, h) = self.size();
        let (cx, cy) = (self.x + w / 2.0, self.y + h / 2.0);
        self.rotation = (self.rotation + 1) % 4;
        let (w, h) = self.size();
        self.x = cx - w / 2.0;
        self.y = cy - h / 2.0;
    }
}

/// 窗口要盖住的范围：内容外扩阴影一圈，夹在 `clip`（显示器让出最下面一行，ADR 0011）里。
pub fn needed(content: Rect, clip: Rect) -> Option<Rect> {
    content.expand(PIN_EDGE).intersect(&clip)
}

/// 手势中换窗口时用的“包络”：以 `need` 为中心各边外扩它自己的一半（两倍大），夹在 `clip` 里。
/// 之后放大约 2 倍、或任意缩小，都只需重画。
pub fn envelope(need: Rect, clip: Rect) -> Rect {
    let grown = Rect::new(need.x - need.w / 2, need.y - need.h / 2, need.w * 2, need.h * 2);
    grown.intersect(&clip).unwrap_or(need).union(&need)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// 窗口不动，只重画内容。
    Redraw,
    /// 只平移窗口到这里，内容像素不变。
    Move(Rect),
    /// 在备用窗口上用这个矩形画好，再一次提交换上来。
    Swap(Rect),
    /// 内容完全在显示器外，什么都不用画（窗口留着不动）。
    Hidden,
}

/// 这一帧怎么上屏。`window` 是当前看得见的窗口，`drawn` 是上一次画进它的内容矩形；
/// `gesture` 为真时换窗口用包络（还要继续变），为假时窗口收成刚好盖住钉图。
pub fn plan(window: Rect, drawn: Rect, content: Rect, clip: Rect, gesture: bool) -> Step {
    let Some(need) = needed(content, clip) else {
        return Step::Hidden;
    };
    if need == window {
        return Step::Redraw;
    }
    // 纯平移：内容尺寸不变，内容在窗口里的位置不变，窗口尺寸不变（没被屏幕边裁得不一样）。
    let dx = content.x - drawn.x;
    let dy = content.y - drawn.y;
    if content.same_size(&drawn)
        && need.same_size(&window)
        && need.x - window.x == dx
        && need.y - window.y == dy
    {
        return Step::Move(need);
    }
    if gesture && window.contains(&need) {
        return Step::Redraw;
    }
    Step::Swap(if gesture { envelope(need, clip) } else { need })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect::new(0, 0, 2560, 1439);

    fn view(x: f64, y: f64, scale: f64) -> View {
        View {
            src_w: 4000,
            src_h: 6000,
            x,
            y,
            scale,
            rotation: 0,
            flip_h: false,
            flip_v: false,
            opacity: 1.0,
        }
    }

    #[test]
    fn zoom_keeps_the_point_under_the_cursor() {
        let mut v = view(100.0, 200.0, 0.1);
        // 光标在图片 (1000, 3000) 像素上。
        let (cx, cy) = (100.0 + 1000.0 * 0.1, 200.0 + 3000.0 * 0.1);
        v.zoom_at(cx, cy, 1.1);
        assert!((v.x + 1000.0 * v.scale - cx).abs() < 1e-9);
        assert!((v.y + 3000.0 * v.scale - cy).abs() < 1e-9);
    }

    #[test]
    fn rotation_turns_around_the_centre() {
        let mut v = view(100.0, 100.0, 0.1);
        let c = v.content();
        v.rotate_cw();
        let r = v.content();
        assert_eq!((r.w, r.h), (c.h, c.w));
        assert_eq!(r.x + r.w / 2, c.x + c.w / 2);
        assert_eq!(r.y + r.h / 2, c.y + c.h / 2);
    }

    #[test]
    fn settled_window_hugs_the_pin() {
        let c = Rect::new(100, 100, 400, 600);
        let w = needed(c, SCREEN).unwrap();
        assert_eq!(plan(w, c, c, SCREEN, false), Step::Redraw);
    }

    #[test]
    fn dragging_on_screen_only_moves_the_window() {
        let c = Rect::new(100, 100, 400, 600);
        let w = needed(c, SCREEN).unwrap();
        let to = Rect::new(107, 95, 400, 600);
        assert_eq!(
            plan(w, c, to, SCREEN, true),
            Step::Move(Rect::new(99, 87, 416, 616))
        );
    }

    #[test]
    fn dragging_past_the_screen_edge_redraws_or_swaps() {
        // 已经被屏幕左边裁掉一块的钉图。
        let c = Rect::new(-20, 100, 400, 600);
        let w = needed(c, SCREEN).unwrap();
        // 再往左拖：窗口被裁得更窄，不能只挪窗口；内容还在窗口里，重画即可。
        let to = Rect::new(-50, 100, 400, 600);
        assert_eq!(plan(w, c, to, SCREEN, true), Step::Redraw);
        // 拖回来时需要更宽的窗口：换窗口。
        let back = Rect::new(-10, 100, 400, 600);
        assert!(matches!(plan(w, to, back, SCREEN, true), Step::Swap(_)));
    }

    #[test]
    fn zooming_in_swaps_once_then_redraws_inside_the_envelope() {
        let mut v = view(1000.0, 400.0, 0.05);
        let mut window = needed(v.content(), SCREEN).unwrap();
        let mut drawn = v.content();
        let mut swaps = 0;
        for _ in 0..7 {
            v.zoom_at(1100.0, 550.0, 1.1);
            match plan(window, drawn, v.content(), SCREEN, true) {
                Step::Swap(r) => {
                    swaps += 1;
                    window = r;
                }
                Step::Redraw => {}
                s => panic!("{s:?}"),
            }
            assert!(window.contains(&needed(v.content(), SCREEN).unwrap()));
            drawn = v.content();
        }
        // 1.1^7 ≈ 1.95：第一格换到两倍大的包络，之后都在包络里。
        assert_eq!(swaps, 1);
        // 停手：收成钉图大小。
        assert!(matches!(
            plan(window, drawn, v.content(), SCREEN, false),
            Step::Swap(r) if r == needed(v.content(), SCREEN).unwrap()
        ));
    }

    #[test]
    fn a_pin_bigger_than_the_screen_uses_a_screen_sized_window_and_redraws() {
        let v = view(-3000.0, -5000.0, 2.0);
        let w = needed(v.content(), SCREEN).unwrap();
        assert_eq!(w, SCREEN);
        let mut v2 = v;
        v2.zoom_at(1280.0, 700.0, 1.1);
        assert_eq!(plan(w, v.content(), v2.content(), SCREEN, true), Step::Redraw);
        assert_eq!(plan(w, v.content(), v2.content(), SCREEN, false), Step::Redraw);
    }

    #[test]
    fn envelope_never_covers_more_than_the_clip() {
        let e = envelope(Rect::new(2000, 1000, 500, 400), SCREEN);
        assert!(SCREEN.contains(&e));
    }
}
