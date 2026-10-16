//! 参考组成员的跨库核对：成员引用的资料库在不在、图还在不在、要不要原位遮蔽。
//!
//! 同一时间只有一个活动资料库（#49）。活动资料库的图经它的参考视角读取（应用壳每次现取，
//! 切换后换成新库的句柄）；其他已登记的资料库只读打开（[`DetachedLenses`]），不对账、不升级、
//! 不写数据库，所以参考组可以引用当前未激活的库。

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use serde::Serialize;
use ts_rs::TS;

use super::ReferenceGroup;
use crate::RegisteredLibrary;
use crate::library::{Error, ReferenceImage, ReferenceLens};

/// 成员暂时不能显示的原因。成员与布局都保留，原因标在成员上。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum UnavailableReason {
    /// 本设备没有登记这个资料库（例如在别的电脑上建的参考组）。
    LibraryNotRegistered,
    /// 资料库登记了但现在打不开（移动盘没插、搬了家、需要升级）。
    #[serde(rename_all = "camelCase")]
    LibraryUnavailable { detail: String },
    /// 资料库里已经没有这张图（永久删除）。
    ImageMissing,
    /// 资料库里还有这张图的记录，但原文件不在了。
    OriginalMissing,
}

impl fmt::Display for UnavailableReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UnavailableReason::LibraryNotRegistered => write!(f, "本设备没有登记这个资料库"),
            UnavailableReason::LibraryUnavailable { detail } => {
                write!(f, "资料库暂时不可用：{detail}")
            }
            UnavailableReason::ImageMissing => write!(f, "参考图已从资料库中删除"),
            UnavailableReason::OriginalMissing => write!(f, "原图文件缺失"),
        }
    }
}

/// 成员此刻的状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum MemberState {
    /// 能显示。`sealed`：安全模式开启且这张图被封印，原位遮蔽。
    Available { sealed: bool },
    /// 暂时不能显示；`message` 是给画师看的原因。
    Unavailable {
        reason: UnavailableReason,
        message: String,
    },
}

/// 一个成员的核对结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemberStatus {
    pub member_id: String,
    pub library_id: String,
    pub image_id: String,
    pub state: MemberState,
}

/// 按“资料库＋参考图”取图的地方。
pub trait ReferenceSource {
    /// `library_id` 的参考视角。
    fn lens(&self, library_id: &str) -> Result<ReferenceLens, UnavailableReason>;

    /// 参考图及是否需要遮蔽；不能显示时给出原因。回收站里的图照常可用。
    fn image(&self, library_id: &str, image_id: &str) -> Result<ReferenceImage, UnavailableReason> {
        let lens = self.lens(library_id)?;
        let image = lens.image(image_id).map_err(|e| match e {
            Error::UnknownImage => UnavailableReason::ImageMissing,
            other => UnavailableReason::LibraryUnavailable {
                detail: other.to_string(),
            },
        })?;
        match lens.original_path(image_id) {
            Ok(path) if path.is_file() => Ok(image),
            _ => Err(UnavailableReason::OriginalMissing),
        }
    }
}

/// 参考组及其成员此刻的状态（主窗口的参考组面板用）。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReferenceGroupView {
    pub group: ReferenceGroup,
    /// 与 `group.members` 一一对应。
    pub members: Vec<MemberStatus>,
}

impl ReferenceGroupView {
    pub fn new(group: ReferenceGroup, source: &dyn ReferenceSource) -> ReferenceGroupView {
        let members = resolve(&group, source);
        ReferenceGroupView { group, members }
    }
}

/// 核对参考组的每个成员，按成员的先后。
pub fn resolve(group: &ReferenceGroup, source: &dyn ReferenceSource) -> Vec<MemberStatus> {
    group
        .members
        .iter()
        .map(|m| MemberStatus {
            member_id: m.id.clone(),
            library_id: m.library_id.clone(),
            image_id: m.image_id.clone(),
            state: match source.image(&m.library_id, &m.image_id) {
                Ok(image) => MemberState::Available {
                    sealed: image.sealed,
                },
                Err(reason) => MemberState::Unavailable {
                    message: reason.to_string(),
                    reason,
                },
            },
        })
        .collect()
}

/// 未激活资料库的只读参考视角，按资料库缓存（拖动钉图时每帧都要核对遮蔽，不能每次重开数据库）。
/// 打不开的不缓存：移动盘接回后下次核对就能用。资料库切换、登记变化时应用壳调用 [`Self::clear`]。
#[derive(Default)]
pub struct DetachedLenses {
    open: Mutex<HashMap<String, (std::path::PathBuf, ReferenceLens)>>,
}

impl DetachedLenses {
    fn get(
        &self,
        library: &RegisteredLibrary,
        safe_mode: bool,
    ) -> Result<ReferenceLens, UnavailableReason> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        let lens = match open.get(&library.id) {
            Some((root, lens)) if *root == library.root => lens.clone(),
            _ => {
                let lens =
                    ReferenceLens::open_detached(&library.root, &library.id).map_err(|e| {
                        UnavailableReason::LibraryUnavailable {
                            detail: match e {
                                Error::NotALibrary(_) => format!(
                                    "{} 处没有这个资料库（移动盘没插，或资料库搬了家）",
                                    library.root.display()
                                ),
                                other => other.to_string(),
                            },
                        }
                    })?;
                open.insert(library.id.clone(), (library.root.clone(), lens.clone()));
                lens
            }
        };
        lens.set_detached_safe_mode(safe_mode);
        Ok(lens)
    }

    /// 关掉全部只读视角（释放数据库文件，例如资料库要搬家、移动盘要拔出）。
    pub fn clear(&self) {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// 本设备上取图的地方：活动资料库经它的参考视角，其他已登记的资料库只读打开。
pub struct References<'a> {
    /// 活动资料库的参考视角（应用壳现取，不缓存）；没有打开资料库时为 `None`。
    pub current: Option<ReferenceLens>,
    /// 本设备登记的资料库。
    pub registry: &'a [RegisteredLibrary],
    pub detached: &'a DetachedLenses,
    /// 安全模式设置：只读打开的库跟随它标记需要遮蔽的图。
    pub safe_mode: bool,
}

impl ReferenceSource for References<'_> {
    fn lens(&self, library_id: &str) -> Result<ReferenceLens, UnavailableReason> {
        if let Some(lens) = self
            .current
            .as_ref()
            .filter(|l| l.library_id() == library_id)
        {
            return Ok(lens.clone());
        }
        let library = self
            .registry
            .iter()
            .find(|l| l.id == library_id)
            .ok_or(UnavailableReason::LibraryNotRegistered)?;
        self.detached.get(library, self.safe_mode)
    }
}
