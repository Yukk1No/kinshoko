//! 贴边隐藏（#63，#7 原型的规则）。
//!
//! 按一次：每个钉图收到所在显示器最近的边，只露 [`SLIVER`] 像素的细边；再按一次回到原位。
//! 指针碰到某个钉图的细边时它滑出、整张贴边可见；指针离开它（留 [`PEEK_SLACK`] 余量）后收回。
//! 这里只算位置；移动窗口、轮询光标与交还焦点在应用壳里。

use std::collections::HashMap;

use super::ScreenRect;

/// 隐藏后露在屏幕上的细边宽度，物理像素。
pub const SLIVER: u32 = 6;
/// 滑出后指针离开钉图多远才收回，物理像素。
pub const PEEK_SLACK: u32 = 12;

/// 参与贴边隐藏的一个钉图：原位上的窗口矩形和它所在的显示器（按原位的中心找）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeskPin {
    pub id: String,
    pub home: ScreenRect,
    pub monitor: ScreenRect,
}

/// 把一个钉图窗口移到 (x, y)（外框左上角，物理像素）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinMove {
    pub pin: String,
    pub x: i32,
    pub y: i32,
}

/// 按一次贴边隐藏键的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toggle {
    /// 按完后钉图是收起的：应用壳此时把焦点交还绘画软件。
    pub hidden: bool,
    pub moves: Vec<PinMove>,
}

#[derive(Debug, Clone)]
struct Tucked {
    /// 收起时的位置与滑出时的位置。
    hidden: (i32, i32),
    peek: (i32, i32),
    size: (u32, u32),
    monitor: ScreenRect,
    peeking: bool,
}

/// 贴边隐藏的状态：哪些钉图收起了、哪个正滑出。
#[derive(Debug, Default)]
pub struct EdgeHide {
    tucked: HashMap<String, Tucked>,
}

impl EdgeHide {
    /// 按一次贴边隐藏键。`pins` 是当前全部钉图。全部已收起时回到原位；
    /// 否则把还没收起的收起（包括收起后新钉的）。
    pub fn toggle(&mut self, pins: &[DeskPin]) -> Toggle {
        self.tucked.retain(|id, _| pins.iter().any(|p| &p.id == id));
        if pins.is_empty() {
            return Toggle {
                hidden: false,
                moves: Vec::new(),
            };
        }
        if pins.iter().all(|p| self.tucked.contains_key(&p.id)) {
            self.tucked.clear();
            let moves = pins
                .iter()
                .map(|p| PinMove {
                    pin: p.id.clone(),
                    x: p.home.x,
                    y: p.home.y,
                })
                .collect();
            return Toggle {
                hidden: false,
                moves,
            };
        }
        let mut moves = Vec::new();
        for p in pins {
            if self.tucked.contains_key(&p.id) {
                continue;
            }
            let tucked = tuck(p.home, p.monitor);
            moves.push(PinMove {
                pin: p.id.clone(),
                x: tucked.hidden.0,
                y: tucked.hidden.1,
            });
            self.tucked.insert(p.id.clone(), tucked);
        }
        Toggle {
            hidden: true,
            moves,
        }
    }

    /// 指针移到了 `cursor`（物理像素）：碰到细边的钉图滑出，指针离开的滑出钉图收回。
    pub fn hover(&mut self, cursor: (i32, i32)) -> Vec<PinMove> {
        let mut moves = Vec::new();
        for (id, t) in &mut self.tucked {
            let want_peek = if t.peeking {
                contains(rect_at(t.peek, t.size), cursor, PEEK_SLACK as i32)
            } else {
                let sliver = intersect(rect_at(t.hidden, t.size), t.monitor);
                sliver.is_some_and(|s| contains(s, cursor, 0))
            };
            if want_peek != t.peeking {
                t.peeking = want_peek;
                let (x, y) = if want_peek { t.peek } else { t.hidden };
                moves.push(PinMove {
                    pin: id.clone(),
                    x,
                    y,
                });
            }
        }
        moves.sort_by(|a, b| a.pin.cmp(&b.pin));
        moves
    }

    /// 这个钉图收起着（包括正滑出）。
    pub fn is_hidden(&self, id: &str) -> bool {
        self.tucked.contains_key(id)
    }

    /// 有收起的钉图：应用壳据此决定是否需要轮询光标。
    pub fn any_hidden(&self) -> bool {
        !self.tucked.is_empty()
    }

    /// 画师把它拖走了或关掉了：不再算收起。
    pub fn release(&mut self, id: &str) {
        self.tucked.remove(id);
    }
}

/// 收起的位置：最近的边（窗口边到显示器边的距离最小者），另一个方向夹在显示器内，
/// 让整条细边都在屏幕上。
fn tuck(home: ScreenRect, monitor: ScreenRect) -> Tucked {
    let (x, y) = (i64::from(home.x), i64::from(home.y));
    let (w, h) = (i64::from(home.width), i64::from(home.height));
    let (mx, my) = (i64::from(monitor.x), i64::from(monitor.y));
    let (mr, mb) = (
        mx + i64::from(monitor.width),
        my + i64::from(monitor.height),
    );
    let s = i64::from(SLIVER);
    let clamp = |v: i64, low: i64, high: i64| v.clamp(low, high.max(low));
    let cx = clamp(x, mx, mr - w);
    let cy = clamp(y, my, mb - h);
    let distances = [x - mx, mr - (x + w), y - my, mb - (y + h)];
    let nearest = (0..4).min_by_key(|&i| distances[i]).unwrap_or(0);
    let (hidden, peek) = match nearest {
        0 => ((mx - w + s, cy), (mx, cy)),
        1 => ((mr - s, cy), (mr - w, cy)),
        2 => ((cx, my - h + s), (cx, my)),
        _ => ((cx, mb - s), (cx, mb - h)),
    };
    let narrow = |(a, b): (i64, i64)| (a as i32, b as i32);
    Tucked {
        hidden: narrow(hidden),
        peek: narrow(peek),
        size: (home.width, home.height),
        monitor,
        peeking: false,
    }
}

fn rect_at((x, y): (i32, i32), (width, height): (u32, u32)) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}

fn intersect(a: ScreenRect, b: ScreenRect) -> Option<ScreenRect> {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (i64::from(a.x) + i64::from(a.width)).min(i64::from(b.x) + i64::from(b.width));
    let bottom = (i64::from(a.y) + i64::from(a.height)).min(i64::from(b.y) + i64::from(b.height));
    (right > i64::from(left) && bottom > i64::from(top)).then(|| ScreenRect {
        x: left,
        y: top,
        width: (right - i64::from(left)) as u32,
        height: (bottom - i64::from(top)) as u32,
    })
}

/// 点在矩形内（向外放宽 `slack`）。右、下边不含。
fn contains(r: ScreenRect, (px, py): (i32, i32), slack: i32) -> bool {
    let (px, py, slack) = (i64::from(px), i64::from(py), i64::from(slack));
    px >= i64::from(r.x) - slack
        && px < i64::from(r.x) + i64::from(r.width) + slack
        && py >= i64::from(r.y) - slack
        && py < i64::from(r.y) + i64::from(r.height) + slack
}
