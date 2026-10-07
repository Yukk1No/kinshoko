//! 桌面钉图的状态与持久化（#63）：重新打开后恢复钉图的位置、裁切、翻转与旋转，
//! 以及右键菜单里的透明度与锁定（#64）。
//!
//! 保存在应用数据目录的 `pins.json`。每次改动先写临时文件再改名，写到一半断电也不会留下半份。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{CaptureHistory, Region, ScreenRect};

const PINS_FILE: &str = "pins.json";
const FORMAT_VERSION: u32 = 1;

/// 恢复时至少留在显示器上的像素，保证钉图还能抓住拖回来。
pub const RESTORE_KEEP: u32 = 64;

/// 缩放的范围（图片像素 → 物理像素）。
pub const MIN_SCALE: f64 = 0.05;
pub const MAX_SCALE: f64 = 10.0;
/// 缩小时窗口较长的一边不小于这么多物理像素，免得缩成抓不住的一点。
pub const MIN_SIDE: u32 = 24;
/// 透明度的下限：再淡就看不见、找不回来了（#64）。
pub const MIN_OPACITY: f64 = 0.1;

/// 钉图在桌面上的摆放：位置、缩放、翻转与旋转。
///
/// 与参考组的成员摆放同义（#66 把它存进参考组）；透明度、锁定只属于桌面，不在这里。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Placement {
    /// 原位：窗口外框左上角，物理像素。贴边隐藏不改变它。
    pub x: i32,
    pub y: i32,
    /// 图片像素 → 物理像素。1 表示未缩放，逐像素显示。
    pub scale: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    /// 顺时针四分之一圈数，0～3。
    pub rotation: u8,
}

impl Default for Placement {
    fn default() -> Self {
        Placement {
            x: 0,
            y: 0,
            scale: 1.0,
            flip_h: false,
            flip_v: false,
            rotation: 0,
        }
    }
}

/// 钉图显示的是什么。#65 加入资料库中的参考视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum PinContent {
    /// 截图历史中的一张截图。
    #[serde(rename_all = "camelCase")]
    Capture { capture_id: String },
}

/// 一个桌面钉图要恢复的全部状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SavedPin {
    pub id: String,
    pub content: PinContent,
    /// 只显示图片的这一块（图片像素）；`None` 为整张。
    pub crop: Option<Region>,
    /// 显示部分的像素尺寸（裁切后、未旋转）。
    pub width: u32,
    pub height: u32,
    pub placement: Placement,
    /// 透明度，[`MIN_OPACITY`]～1。只属于桌面钉图（#64）。
    #[serde(default = "opaque")]
    pub opacity: f64,
    /// 锁定后不响应拖动与缩放（#64）。
    #[serde(default)]
    pub locked: bool,
}

fn opaque() -> f64 {
    1.0
}

impl SavedPin {
    /// 窗口的物理像素尺寸：显示部分按缩放取整，旋转奇数圈时宽高互换。
    /// 与前端 `pinCanvasSize` 的算法相同，canvas 后备尺寸正好等于窗口。
    pub fn window_size(&self) -> (u32, u32) {
        let p = &self.placement;
        let (w, h) = if p.rotation % 2 == 1 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        };
        let side = |v: u32| ((f64::from(v) * p.scale).round() as u32).max(1);
        (side(w), side(h))
    }

    /// 原位上的窗口矩形。
    pub fn rect(&self) -> ScreenRect {
        let (width, height) = self.window_size();
        ScreenRect {
            x: self.placement.x,
            y: self.placement.y,
            width,
            height,
        }
    }

    /// 拖动到 (x, y)（原位，物理像素）。锁定时不动，返回 false。
    pub fn move_to(&mut self, x: i32, y: i32) -> bool {
        if self.locked {
            return false;
        }
        self.placement.x = x;
        self.placement.y = y;
        true
    }

    /// 透明度限制在 [`MIN_OPACITY`]～1；读不懂的值按不透明。
    pub fn set_opacity(&mut self, opacity: f64) {
        self.opacity = if opacity.is_nan() {
            1.0
        } else {
            opacity.clamp(MIN_OPACITY, 1.0)
        };
    }

    /// 缩放到 `scale`，屏幕上的 `anchor`（物理像素，例如光标）保持不动。
    /// 缩放限制在 [`MIN_SCALE`]～[`MAX_SCALE`]，较长的一边不小于 [`MIN_SIDE`]。
    /// 锁定时不缩放，返回 false。
    pub fn zoom(&mut self, scale: f64, anchor: (f64, f64)) -> bool {
        if self.locked {
            return false;
        }
        let longest = f64::from(self.width.max(self.height).max(1));
        let floor = (f64::from(MIN_SIDE) / longest).max(MIN_SCALE);
        let scale = scale.clamp(floor.min(MAX_SCALE), MAX_SCALE);
        let old = self.rect();
        self.placement.scale = scale;
        let (w, h) = self.window_size();
        // 锚点在窗口内的相对位置不变。
        let fx = (anchor.0 - f64::from(old.x)) / f64::from(old.width.max(1));
        let fy = (anchor.1 - f64::from(old.y)) / f64::from(old.height.max(1));
        self.placement.x = (anchor.0 - fx * f64::from(w)).round() as i32;
        self.placement.y = (anchor.1 - fy * f64::from(h)).round() as i32;
        true
    }

    /// 顺时针旋转 `quarter_turns` 个四分之一圈（负数为逆时针），中心不动。
    pub fn rotate(&mut self, quarter_turns: i32) {
        let before = self.rect();
        let r = (i32::from(self.placement.rotation) + quarter_turns).rem_euclid(4);
        self.placement.rotation = r as u8;
        self.keep_centre(before);
    }

    /// 水平（`horizontal`）或垂直翻转。翻转作用在旋转之前的图片上，窗口不动。
    pub fn flip(&mut self, horizontal: bool) {
        let p = &mut self.placement;
        // 旋转奇数圈时，屏幕上的水平方向是图片的垂直方向。
        if horizontal == p.rotation.is_multiple_of(2) {
            p.flip_h = !p.flip_h;
        } else {
            p.flip_v = !p.flip_v;
        }
    }

    fn keep_centre(&mut self, before: ScreenRect) {
        let (w, h) = self.window_size();
        let cx = i64::from(before.x) * 2 + i64::from(before.width);
        let cy = i64::from(before.y) * 2 + i64::from(before.height);
        self.placement.x = ((cx - i64::from(w)) / 2) as i32;
        self.placement.y = ((cy - i64::from(h)) / 2) as i32;
    }

    fn capture_id(&self) -> &str {
        match &self.content {
            PinContent::Capture { capture_id } => capture_id,
        }
    }
}

/// `pins.json` 的内容。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PinsFile {
    format_version: u32,
    pins: Vec<SavedPin>,
}

/// 桌面钉图的持久化。不是线程安全的；应用壳把它放在锁里。
pub struct PinStore {
    path: PathBuf,
    pins: Vec<SavedPin>,
}

impl PinStore {
    /// 打开 `dir/pins.json`；没有或读不懂时从空开始（钉图只是工作状态，丢了不影响资料）。
    pub fn open(dir: &Path) -> io::Result<PinStore> {
        fs::create_dir_all(dir)?;
        let path = dir.join(PINS_FILE);
        let pins = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<PinsFile>(&bytes)
                .map(|f| f.pins)
                .unwrap_or_default(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok(PinStore { path, pins })
    }

    /// 启动时恢复钉图：去掉截图已不在截图历史中的，把离开了所有显示器的拉回屏幕
    /// （至少 [`RESTORE_KEEP`] 像素可见），并让截图历史知道这些截图仍被钉住。
    /// 返回要重新打开的钉图，按保存的先后。
    pub fn restore(
        &mut self,
        history: &mut CaptureHistory,
        monitors: &[ScreenRect],
    ) -> Vec<SavedPin> {
        self.pins.retain(|p| history.file(p.capture_id()).is_some());
        for pin in &mut self.pins {
            let (x, y) = pull_onto_screen(pin.rect(), monitors);
            pin.placement.x = x;
            pin.placement.y = y;
            history.pin(pin.capture_id());
        }
        self.pins.clone()
    }

    pub fn pins(&self) -> &[SavedPin] {
        &self.pins
    }

    pub fn get(&self, id: &str) -> Option<&SavedPin> {
        self.pins.iter().find(|p| p.id == id)
    }

    /// 改一个钉图的状态：`edit` 返回后需要 [`save`](Self::save)。不存在时为 `None`。
    pub fn edit<T>(&mut self, id: &str, edit: impl FnOnce(&mut SavedPin) -> T) -> Option<T> {
        self.pins.iter_mut().find(|p| p.id == id).map(edit)
    }

    /// 加入或替换一个钉图。
    pub fn put(&mut self, pin: SavedPin) {
        match self.pins.iter_mut().find(|p| p.id == pin.id) {
            Some(old) => *old = pin,
            None => self.pins.push(pin),
        }
    }

    /// 画师关闭了钉图：不再恢复。
    pub fn remove(&mut self, id: &str) -> Option<SavedPin> {
        let at = self.pins.iter().position(|p| p.id == id)?;
        Some(self.pins.remove(at))
    }

    pub fn save(&self) -> io::Result<()> {
        let file = PinsFile {
            format_version: FORMAT_VERSION,
            pins: self.pins.clone(),
        };
        let tmp = self.path.with_extension("json.tmp");
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(&file).map_err(io::Error::other)?,
        )?;
        fs::rename(&tmp, &self.path)
    }
}

/// 窗口还有足够部分在某台显示器上时原样返回；否则拉回最近的显示器，
/// 每个方向至少 [`RESTORE_KEEP`] 像素（窗口更小时整个）可见。
pub fn pull_onto_screen(rect: ScreenRect, monitors: &[ScreenRect]) -> (i32, i32) {
    let keep_w = RESTORE_KEEP.min(rect.width) as i64;
    let keep_h = RESTORE_KEEP.min(rect.height) as i64;
    let overlap = |m: &ScreenRect| {
        let w = (i64::from(rect.x) + i64::from(rect.width))
            .min(i64::from(m.x) + i64::from(m.width))
            - i64::from(rect.x).max(i64::from(m.x));
        let h = (i64::from(rect.y) + i64::from(rect.height))
            .min(i64::from(m.y) + i64::from(m.height))
            - i64::from(rect.y).max(i64::from(m.y));
        (w, h)
    };
    if monitors.iter().any(|m| {
        let (w, h) = overlap(m);
        w >= keep_w && h >= keep_h
    }) {
        return (rect.x, rect.y);
    }
    let centre = |r: &ScreenRect| {
        (
            i64::from(r.x) * 2 + i64::from(r.width),
            i64::from(r.y) * 2 + i64::from(r.height),
        )
    };
    let (cx, cy) = centre(&rect);
    let Some(m) = monitors.iter().min_by_key(|m| {
        let (mx, my) = centre(m);
        (mx - cx).pow(2) + (my - cy).pow(2)
    }) else {
        return (rect.x, rect.y);
    };
    let clamp = |v: i32, start: i32, len: u32, size: u32, keep: i64| {
        let low = i64::from(start) - i64::from(size) + keep;
        let high = i64::from(start) + i64::from(len) - keep;
        i64::from(v).clamp(low, high.max(low)) as i32
    };
    (
        clamp(rect.x, m.x, m.width, rect.width, keep_w),
        clamp(rect.y, m.y, m.height, rect.height, keep_h),
    )
}
