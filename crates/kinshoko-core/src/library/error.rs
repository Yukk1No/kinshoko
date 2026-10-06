use std::fmt;
use std::path::PathBuf;

/// 资料库操作的错误。`Display` 是给画师看的中文说明。
#[derive(Debug)]
pub enum Error {
    InvalidName,
    NotEmpty(PathBuf),
    NotALibrary(PathBuf),
    UnknownImage,
    InvalidCursor,
    Io(std::io::Error),
    Db(rusqlite::Error),
    Migration(rusqlite_migration::Error),
    Image(image::ImageError),
    /// 原图无法解码或不再是支持的格式。
    Undecodable(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidName => write!(f, "资料库名称不能为空"),
            Error::NotEmpty(p) => write!(f, "所选位置不是空文件夹：{}", p.display()),
            Error::NotALibrary(p) => write!(f, "这里没有 Kinshoko 资料库：{}", p.display()),
            Error::UnknownImage => write!(f, "资料库中没有这张参考图"),
            Error::InvalidCursor => write!(f, "浏览位置无效"),
            Error::Io(e) => write!(f, "读写文件失败：{e}"),
            Error::Db(e) => write!(f, "资料库数据库出错：{e}"),
            Error::Migration(e) => write!(f, "资料库格式无法升级：{e}"),
            Error::Image(e) => write!(f, "图片解码失败：{e}"),
            Error::Undecodable(e) => write!(f, "原图无法解码：{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e)
    }
}

impl From<rusqlite_migration::Error> for Error {
    fn from(e: rusqlite_migration::Error) -> Self {
        Error::Migration(e)
    }
}

impl From<image::ImageError> for Error {
    fn from(e: image::ImageError) -> Self {
        Error::Image(e)
    }
}
