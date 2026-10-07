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
    /// 分页游标所依据的结果集已经变了（换了资料库、查询或浏览视角，或可见集合的修订号前进）：
    /// 接着翻会遗漏或重复，调用方应从第一页重新浏览（#77 S4）。
    CursorExpired,
    InvalidDisplaySize,
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
    /// 资料库里没有登记这个 Eagle 来源。
    UnknownEagleSource,
    /// 这个位置已经登记为另一个 Eagle 来源。
    EagleLocationTaken,
    /// 资料库的安全模式与请求所期望的不同（刚切换过），结果按旧视角作废（#76）。
    LensChanged,
    /// 资料库由旧版本写成，要先作为活动资料库打开一次（升级）才能在别处读取（#66）。
    OutdatedLibrary,
    /// 参考组包里的原图没能进库（读不出、解码失败或与包内记录不符，#68）。
    PackageImage(String),
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
            Error::UnknownFolder => write!(f, "资料库中没有这个文件夹"),
            Error::FolderCycle => write!(f, "文件夹不能移进它自己或它的子文件夹"),
            Error::InvalidCursor => write!(f, "浏览位置无效"),
            Error::CursorExpired => write!(f, "浏览结果已变化，请从头重新浏览"),
            Error::InvalidDisplaySize => write!(f, "显示尺寸必须大于零"),
            Error::UnknownTag => write!(f, "资料库中没有这个标签"),
            Error::UnknownTagGroup => write!(f, "资料库中没有这个标签分组"),
            Error::InvalidTagName => write!(f, "标签名称不能为空"),
            Error::AmbiguousTag(n) => write!(f, "有多个标签叫“{n}”，请从候选中选择"),
            Error::DuplicateTagName(n) => write!(f, "同一命名空间里已有标签叫“{n}”"),
            Error::ExternalTaken(n) => write!(f, "外部名称 {n} 已对应到另一个标签"),
            Error::SameTag => write!(f, "相近标签要选另一个标签"),
            Error::UnknownEagleSource => write!(f, "资料库里没有登记这个 Eagle 来源"),
            Error::EagleLocationTaken => write!(f, "这个位置已经登记为另一个 Eagle 来源"),
            Error::LensChanged => write!(f, "安全模式刚切换过，请重新查找"),
            Error::OutdatedLibrary => {
                write!(f, "资料库需要先在 Kinshoko 中打开一次以完成升级")
            }
            Error::PackageImage(why) => write!(f, "参考组包里的原图没能导入：{why}"),
            Error::NamespaceGroup => write!(f, "这个分组按命名空间列出标签，不能手动调整成员"),
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
