//! 编排与渲染层之间的口子。编排在界面线程上，渲染（GPU 设备、读图、颜色转换、上传、Present）在
//! 别的线程：这里的方法都立即返回，结果以 [`RenderEvent`] 回到界面线程。测试用一个只记录的假实现。

use std::sync::Arc;

use kinshoko_core::desktop::frame::SourceSize;
use kinshoko_core::desktop::{SavedPin, ScreenRect};
use pin_shell::PinId;

use super::caption::Caption;

/// 往一个窗口槽画一帧并 Present。
#[derive(Debug, Clone, PartialEq)]
pub struct DrawJob {
    pub pin: PinId,
    /// 0 或 1，[`pin_shell::PinShell::create`] 给的目标下标。
    pub slot: usize,
    /// 槽的窗口。
    pub window: ScreenRect,
    /// 钉图内容这一帧在屏幕上的矩形。
    pub content: ScreenRect,
    /// 钉图此刻的状态（翻转旋转、裁切、透明度）。
    pub state: SavedPin,
    /// 钉图所在显示器的颜色配置文件；`None` 按 sRGB。
    pub display: Option<Arc<[u8]>>,
    /// 那台显示器的缩放比例：以 CSS 像素定的尺寸（模糊半径、细线）按它换成物理像素。
    pub display_scale: f64,
    /// 遮蔽的程度：1 为完全遮蔽（模糊并盖墨色），0 为不遮蔽；确认显示后淡出时在两者之间。
    pub veil: f32,
    /// 增强钉图边缘（设置）：加一圈浅色细线。
    pub ring: bool,
    /// 出现提示框的不透明度（新钉图出现后 0.9 秒里从 1 渐隐到 0）。
    pub appear: f32,
    /// 深色主题（提示框与小圆锁的颜色）。
    pub dark: bool,
    /// 读不到图：画中性灰的占位，不用源图。
    pub placeholder: bool,
    /// 说明层：小圆锁、原因文字、提示。
    pub caption: Caption,
}

/// 渲染层做完了一件事。
#[derive(Debug, Clone, PartialEq)]
pub enum RenderEvent {
    /// [`RenderPort::draw`] 已 Present（或失败）。同一张钉图的绘制按顺序完成。
    Drawn {
        pin: PinId,
        result: Result<(), String>,
    },
    /// [`RenderPort::load`] 要的源图已上传，之后的绘制用它。只报最近一次要的。
    Loaded { pin: PinId, size: SourceSize },
    /// 读不到图、转换或上传失败。
    LoadFailed { pin: PinId, reason: String },
    /// [`RenderPort::detach`] 完成：这张钉图的 Surface 已丢掉，平台层可以关它的窗口了。
    Detached { pin: PinId },
}

/// 渲染层。没有钉图时实现不持有 GPU 设备。
pub trait RenderPort {
    /// 给一张钉图的两个窗口槽建 Surface（下标即槽号）。目标在 [`RenderPort::detach`] 报完之前有效。
    fn attach(&mut self, pin: PinId, targets: [wgpu::SurfaceTargetUnsafe; 2]);
    /// 读这张钉图的源图（`size` 见 [`kinshoko_core::desktop::frame::source_size`]），转成线性像素后上传，
    /// 替换原来的图。
    fn load(&mut self, pin: PinId, state: &SavedPin, size: SourceSize);
    fn draw(&mut self, job: DrawJob);
    /// 丢掉这张钉图的 Surface 与图；完成后报 [`RenderEvent::Detached`]。最后一张丢掉后释放 GPU 设备。
    fn detach(&mut self, pin: PinId);
}
