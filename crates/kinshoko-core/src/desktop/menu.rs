//! 钉图的统一样式菜单（#102 T5，#106）。
//!
//! 钉图窗口小且透明，菜单画不下，也不能在里面渲染：菜单由一个独立的置顶无边框菜单窗口承载。
//! 菜单窗口盖住指针所在的显示器（让出最下面一行，[`menu_surface`]），菜单从指针处（[`MenuSurface::x`]、`y`）
//! 弹出；页面里的菜单按 Base UI 的碰撞规则翻转、平移，保持在窗口——也就是这台显示器——之内，
//! 子菜单同样如此。窗口按物理像素放，页面按自己的 devicePixelRatio 换算，125%／150% 缩放下也对。
//! 菜单要显示的状态（[`PinMenu`]）由应用壳按钉图此刻的状态算出。

use serde::Serialize;
use ts_rs::TS;

use super::{PinContent, SavedPin, ScreenRect};

/// 菜单窗口放在哪里、菜单从哪里弹出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct MenuSurface {
    /// 菜单窗口：指针所在的显示器让出最下面一行（[`super::overlay_window`]），物理像素。
    pub window: ScreenRect,
    /// 指针相对窗口左上角的位置，物理像素，总在窗口内。
    pub x: i32,
    pub y: i32,
}

/// 指针 `cursor`（屏幕物理像素）处弹出菜单时，菜单窗口的位置与锚点。
///
/// 用指针所在的显示器（左、上边含，右、下边不含）；指针落在显示器之间的空隙或屏幕外时，
/// 用最近的那台，锚点夹在它里面。没有显示器时为 `None`。
pub fn menu_surface(cursor: (i32, i32), monitors: &[ScreenRect]) -> Option<MenuSurface> {
    let (cx, cy) = (i64::from(cursor.0), i64::from(cursor.1));
    // 点到显示器的距离（平方）；在显示器内为 0。
    let distance = |m: &&ScreenRect| {
        let (left, top) = (i64::from(m.x), i64::from(m.y));
        let right = left + i64::from(m.width) - 1;
        let bottom = top + i64::from(m.height) - 1;
        let dx = (left - cx).max(0).max(cx - right);
        let dy = (top - cy).max(0).max(cy - bottom);
        dx * dx + dy * dy
    };
    let monitor = monitors
        .iter()
        .filter(|m| m.width > 0 && m.height > 0)
        .min_by_key(distance)?;
    // 菜单窗口让出最下面一行，免得被当成全屏程序（#230，ADR 0011）；锚点夹在窗口里。
    let window = super::overlay_window(*monitor);
    let inside = |c: i64, start: i32, size: u32| {
        (c - i64::from(start)).clamp(0, i64::from(size.max(1)) - 1) as i32
    };
    Some(MenuSurface {
        window,
        x: inside(cx, window.x, window.width),
        y: inside(cy, window.y, window.height),
    })
}

/// 钉图菜单要显示的状态。菜单项的取舍与文字在页面里（`src/desktop/PinMenu.tsx`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PinMenu {
    pub pin: String,
    /// 截图钉图（还不在资料库里）；否则是资料库钉图。
    pub capture: bool,
    /// 透明度，百分比。
    pub opacity: u32,
    pub locked: bool,
    /// 已是原始大小（100%）。
    pub actual_size: bool,
    /// 安全模式下被遮蔽着（资料库钉图）。
    pub veiled: bool,
    /// 能收藏：截图钉图，且已有登记的资料库。
    pub can_collect: bool,
    /// 来自参考组时，那个参考组的名称（“存回参考组”）。
    pub group: Option<String>,
    /// 画师点了遮蔽钉图上的小圆锁：只问“显示这张图？”（原生钉图，#285）。
    pub confirm_reveal: bool,
}

impl PinMenu {
    /// `veiled`：钉图此刻被遮蔽；`has_library`：已有登记的资料库；`group`：来自的参考组的名称。
    pub fn new(pin: &SavedPin, veiled: bool, has_library: bool, group: Option<String>) -> PinMenu {
        let capture = matches!(pin.content, PinContent::Capture { .. });
        PinMenu {
            pin: pin.id.clone(),
            capture,
            opacity: (pin.opacity * 100.0).round() as u32,
            locked: pin.locked,
            actual_size: (pin.placement.scale - 1.0).abs() < 1e-9,
            veiled,
            can_collect: capture && has_library,
            group,
            confirm_reveal: false,
        }
    }
}

/// 做完钉图菜单里的一项后在钉图上提示什么（#355）。文字由菜单页面按界面语言取。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PinNotice {
    Locked,
    Unlocked,
    Copied,
    /// 截图钉图的“收藏”：保存位置在主窗口里选。
    ChooseSaveLocation,
    /// 截图钉图要先收藏进图库，才能加入参考组。
    CollectFirst,
    SavedToGroup {
        name: String,
    },
    AddedToGroup {
        name: String,
    },
    Failed {
        #[ts(as = "crate::command_error::ErrorKind")]
        error: crate::CommandError,
    },
}

impl<E: Into<crate::CommandError>> From<E> for PinNotice {
    fn from(error: E) -> Self {
        PinNotice::Failed {
            error: error.into(),
        }
    }
}

/// 菜单窗口要显示的一次菜单：编号（关掉旧的、不认过期的选择）、窗口与锚点、菜单状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PinMenuOpen {
    pub generation: u32,
    pub surface: MenuSurface,
    pub menu: PinMenu,
}

/// 钉图菜单“在 Kinshoko 中打开”请主窗口打开什么：资料库钉图的参考图（查看器，参考视图），
/// 或截图钉图所在的截图历史。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum OpenInKinshoko {
    #[serde(rename_all = "camelCase")]
    Reference {
        library_id: String,
        image_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Capture { capture_id: String },
}

impl OpenInKinshoko {
    /// 钉图对应的打开请求。
    pub fn of(pin: &SavedPin) -> OpenInKinshoko {
        match &pin.content {
            PinContent::Reference {
                library_id,
                image_id,
                ..
            } => OpenInKinshoko::Reference {
                library_id: library_id.clone(),
                image_id: image_id.clone(),
            },
            PinContent::Capture { capture_id } => OpenInKinshoko::Capture {
                capture_id: capture_id.clone(),
            },
        }
    }
}
