use std::fmt;

/// 渲染层的错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// 没有可用的显卡，后备适配器也没有。
    NoAdapter(String),
    /// 建设备失败。
    Device(String),
    /// GPU 设备丢失：调用方 [`Renderer::rebuild`](crate::Renderer::rebuild) 后重新上传。
    DeviceLost,
    /// 句柄（图、查找表、说明层、Surface）属于重建之前的设备。
    Stale,
    /// 像素或查找表的尺寸与说明不符，或超出设备上限。
    Invalid(String),
    /// Surface 建不了、取不到后台缓冲等。
    Surface(String),
    /// 其余 GPU 错误（验证错误、读回失败）。
    Gpu(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NoAdapter(e) => write!(f, "没有可用的显卡：{e}"),
            Error::Device(e) => write!(f, "建 GPU 设备失败：{e}"),
            Error::DeviceLost => f.write_str("GPU 设备丢失"),
            Error::Stale => f.write_str("句柄属于重建之前的 GPU 设备"),
            Error::Invalid(e) => write!(f, "数据不合要求：{e}"),
            Error::Surface(e) => write!(f, "窗口画面出错：{e}"),
            Error::Gpu(e) => write!(f, "GPU 出错：{e}"),
        }
    }
}

impl std::error::Error for Error {}
