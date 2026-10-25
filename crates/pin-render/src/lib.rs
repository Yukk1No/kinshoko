//! 桌面钉图的 GPU 绘制（ADR 0013、ADR 0014）。
//!
//! 一个 [`Renderer`] 持有 GPU 设备；每张钉图上传一张 [`Image`]（线性工作空间、预乘 alpha 的
//! `Rgba16Float`，带完整 mip 链），每台显示器（或每种源空间）一张 [`Lut`]，每个窗口槽一个
//! [`Surface`]。[`Renderer::draw`] 按 [`Draw`] 把钉图画进窗口并 Present：缩放、裁切、翻转旋转、
//! 透明度、阴影、增强边缘、遮蔽和说明层都在着色器里做，颜色最后查表转到显示器编码。
//!
//! 只依赖 wgpu：窗口由平台层给出 `wgpu::SurfaceTargetUnsafe`，这里不认识任何平台类型；
//! 像素与查找表由 `kinshoko-core::desktop::pin_colour` 生成，这里不做颜色管理。
//!
//! 采样：缩小时在 mip 链上三线性；1:1 时逐像素取最近的纹素（不插值）；放大时 Catmull-Rom
//! （与 Chromium `imageSmoothingQuality = "high"` 放大相当）。插值都在线性光下，而且只读裁切范围里
//! 完整的纹素，局部钉图不会混进局部以外的像素。
//!
//! GPU 设备丢失（驱动更新、远程桌面切换）时 [`Renderer::draw`] 返回 [`Error::DeviceLost`]；
//! 调用方 [`Renderer::rebuild`]，再重新上传图、查找表，重建 Surface。旧的句柄在新设备上用会得到
//! [`Error::Stale`]。

mod block_on;
mod error;
mod renderer;
mod uniform;

pub use error::Error;
pub use renderer::{Image, Lut, MemoryReport, Overlay, Renderer, Surface};

/// 查找表每一维的结点数（与 `kinshoko-core::desktop::pin_colour::LUT_SIZE` 相同）。
pub const LUT_SIZE: usize = 33;
/// 查找表输入覆盖的编码值范围（与 `pin_colour::LUT_DOMAIN` 相同）。
pub const LUT_DOMAIN: (f32, f32) = (-0.5, 1.5);
/// 显示器曲线的项数（与 `pin_colour::CURVE_SIZE` 相同）。
pub const CURVE_SIZE: usize = 4096;

/// 增强钉图边缘那圈细线的颜色（`--pin-ring`：白色，60%）。
pub const RING_COLOUR: [f32; 4] = [1.0, 1.0, 1.0, 0.6];

/// 上传的像素：线性工作空间、预乘 alpha 的 RGBA，每个分量是 f16 的位（`pin_colour::PinPixels`）。
#[derive(Debug, Clone, Copy)]
pub struct Pixels<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u16],
}

/// 到显示器的查找表（`pin_colour::PinLut`）。
#[derive(Debug, Clone, Copy)]
pub enum LutData<'a> {
    /// 源空间就是显示器：编码值原样输出。
    Identity,
    /// `clut`：[`LUT_SIZE`]³ 项 RGB f32；`curve`：[`CURVE_SIZE`] 项 RGB f32；`linear`：`clut` 的
    /// 输入是线性值（[`LUT_DOMAIN`] 两端按扩展 sRGB 曲线展开），否则是编码值。约定见 `pin_colour`。
    Table {
        clut: &'a [f32],
        curve: &'a [f32],
        linear: bool,
    },
}

/// 屏幕上的窗口：左上角与尺寸，物理像素。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 矩形：屏幕物理像素（[`Draw::content`]），或源图的像素（[`Draw::crop`]）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
}

/// 翻转与旋转，与现在的钉图相同：先在源图上翻转，再绕中心顺时针转 `quarter` 个四分之一圈。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Turn {
    pub quarter: u8,
    pub flip_h: bool,
    pub flip_v: bool,
}

/// 遮蔽（安全模式）：原位模糊，盖一层墨色。`amount` 从 1 降到 0 就是确认显示后的淡出。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Veil {
    /// 0～1：模糊半径与墨色的不透明度都乘上它。
    pub amount: f32,
    /// 高斯模糊的标准差，屏幕物理像素（CSS `blur(14px)` × 缩放比例）。
    pub blur: f32,
    /// 墨色：sRGB 编码值（0～1）与不透明度（`--veil`，0.92）。
    pub ink: [f32; 4],
}

/// 一次绘制。
#[derive(Debug, Clone, Copy)]
pub struct Draw<'a> {
    /// 窗口（决定画面尺寸与原点）。
    pub window: Window,
    /// 钉图内容（转过之后）在屏幕上的矩形。
    pub content: Rect,
    /// 要显示的源图部分，源图像素。整图为 `(0, 0, 宽, 高)`。
    pub crop: Rect,
    pub turn: Turn,
    /// 整张钉图（含阴影、细线、说明层）的不透明度。
    pub opacity: f32,
    /// 阴影那一圈的宽度（`PIN_EDGE`），物理像素；0 时不画阴影。阴影与 `pin-edge.css` 的两层投影相同，
    /// 这一圈里 alpha 至少 1/255，指针按在上面能命中钉图。
    pub edge: f32,
    /// 增强边缘细线的宽度，物理像素；0 时不画。
    pub ring: f32,
    pub veil: Option<Veil>,
    /// 说明层（小圆锁、原因文字）与它左上角在屏幕上的位置，按 1:1 画在最上面。
    pub overlay: Option<(&'a Overlay, [f32; 2])>,
}

impl<'a> Draw<'a> {
    /// 只画图：不透明、没有阴影、细线、遮蔽和说明层。
    pub fn new(window: Window, content: Rect, crop: Rect) -> Draw<'a> {
        Draw {
            window,
            content,
            crop,
            turn: Turn::default(),
            opacity: 1.0,
            edge: 0.0,
            ring: 0.0,
            veil: None,
            overlay: None,
        }
    }
}

/// 读回的画面：预乘 alpha 的 RGBA8，显示器编码，逐行排列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl RgbaImage {
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.width + x) * 4) as usize;
        [
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]
    }
}
