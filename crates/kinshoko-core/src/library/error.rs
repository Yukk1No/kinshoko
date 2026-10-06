use std::fmt;
use std::path::PathBuf;

/// 资料库操作的错误。`Display` 是给画师看的中文说明。
#[derive(Debug)]
pub enum Error {
    InvalidName,
    NotEmpty(PathBuf),
    NotALibrary(PathBuf),
    UnknownImage,
    UnknownFolder,
    /// 文件夹不能移进它自己或它的子文件夹。
    FolderCycle,
    InvalidCursor,
    UnknownTag,
    UnknownTagGroup,
    InvalidTagName,
    /// 同一命名空间里有多个标签叫这个名字（或别名），需要按 id 指定。
    AmbiguousTag(String),
    /// 同一命名空间里已有标签在这个语言下叫这个名字。
    DuplicateTagName(String),
    /// 这个外部名称已对应到另一个标签。
    ExternalTaken(String),
    /// 命名空间分组的成员由命名空间决定，不能手动设置。
    NamespaceGroup,
    /// 个人近似对应表的一条要两个不同的标签。
    SameTag,
    Io(std::io::Error),
    Db(rusqlite::Error),
    Migration(rusqlite_migration::Error),
    Image(image::ImageError),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidName => write!(f, "资料库名称不能为空"),
            Error::NotEmpty(p) => write!(f, "所选位置不是空文件夹：{}", p.display()),
            Error::NotALibrary(p) => write!(f, "这里没有 Kinshoko 资料库：{}", p.display()),
            Error::UnknownImage => write!(f, "资料库中没有这张参考图"),
            Error::UnknownFolder => write!(f, "资料库中没有这个文件夹"),
            Error::FolderCycle => write!(f, "文件夹不能移进它自己或它的子文件夹"),
            Error::InvalidCursor => write!(f, "浏览位置无效"),
            Error::UnknownTag => write!(f, "资料库中没有这个标签"),
            Error::UnknownTagGroup => write!(f, "资料库中没有这个标签分组"),
            Error::InvalidTagName => write!(f, "标签名称不能为空"),
            Error::AmbiguousTag(n) => write!(f, "有多个标签叫“{n}”，请从候选中选择"),
            Error::DuplicateTagName(n) => write!(f, "同一命名空间里已有标签叫“{n}”"),
            Error::ExternalTaken(n) => write!(f, "外部名称 {n} 已对应到另一个标签"),
            Error::SameTag => write!(f, "相近标签要选另一个标签"),
            Error::NamespaceGroup => write!(f, "这个分组按命名空间列出标签，不能手动调整成员"),
            Error::Io(e) => write!(f, "读写文件失败：{e}"),
            Error::Db(e) => write!(f, "资料库数据库出错：{e}"),
            Error::Migration(e) => write!(f, "资料库格式无法升级：{e}"),
            Error::Image(e) => write!(f, "图片解码失败：{e}"),
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
