use crate::LibraryRegistration;
use crate::library::BrowseScope;
use crate::search::ConditionTree;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum WorkspaceScope {
    #[default]
    All,
    Library {
        library_id: String,
        #[serde(default)]
        scope: BrowseScope,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceQuery {
    #[serde(default)]
    pub scope: WorkspaceScope,
    #[serde(default)]
    pub conditions: ConditionTree,
    #[serde(default)]
    pub cursor: Option<String>,
    pub limit: u32,
    /// 调用方已经有占位图的卡片 id（#313）：占位图按内容寻址、永远不变，这些卡片不再带它。
    #[serde(default)]
    pub known_placeholders: Vec<String>,
    /// 同一图集叠成一摞（#418）：每个图集只占一格，各页放进卡片的 [`WorkspaceCard::set`]。
    #[serde(default)]
    pub stack_sets: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceSource {
    pub library_id: String,
    pub library_name: String,
    pub image_id: String,
    #[ts(as = "Option<crate::command_error::ErrorKind>")]
    pub unavailable: Option<crate::CommandError>,
    pub matches: bool,
    pub deleted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceCard {
    /// Stable byte identity, also used for scroll anchors.
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// 占位图（#110）的 `data:` 地址，取自显示用的来源；还没生成时、或请求时报为已有的
    /// （[`WorkspaceQuery::known_placeholders`]）为空。缩略图地址由界面按 `libraryId`、`imageId`
    /// 与档位拼出（#313），与 `thumb` 协议的路径相同。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placeholder: Option<String>,
    pub adult: bool,
    /// Explicit available matching source used for display; browsing never activates it.
    pub library_id: String,
    pub image_id: String,
    pub sources: Vec<WorkspaceSource>,
    /// 叠成一摞时（[`WorkspaceQuery::stack_sets`]）这一格的图集：至少两页，卡片本身是封面，即第一页。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub set: Option<WorkspaceImageSet>,
}
/// 图片墙上叠成一摞的图集（#418）：只含这次浏览能显示的页（符合查找、不被安全模式封印），按页序排。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceImageSet {
    /// 图集键，例如 `pixiv:123`。
    pub key: String,
    /// 各页的卡片，第一页是封面。只有前 [`STACK_PLACEHOLDER_PAGES`] 页带占位图。
    pub pages: Vec<WorkspaceCard>,
}
/// 一摞里带占位图的页数：封面与露在下面的三层。
pub const STACK_PLACEHOLDER_PAGES: usize = 4;
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceStatus {
    pub revision: String,
    pub libraries: Vec<LibraryRegistration>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspacePage {
    pub cards: Vec<WorkspaceCard>,
    pub next_cursor: Option<String>,
    /// 结果的格数：叠成一摞时一摞算一格。
    pub total: u32,
    /// 叠成一摞时（[`WorkspaceQuery::stack_sets`]）结果里的张数；不叠放时与 `total` 相同，省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub images: Option<u32>,
    pub status: WorkspaceStatus,
}
/// One provider root. Missing providers keep their identity and reason, without stale folders/counts.
/// `descendants` counts live visible images per subtree, deduplicated across folder memberships.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceDirectory {
    pub registration: LibraryRegistration,
    pub sidebar: Option<crate::library::Sidebar>,
    pub unassigned: u32,
    pub descendants: BTreeMap<String, u32>,
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceDirectories {
    pub status: WorkspaceStatus,
    pub providers: Vec<WorkspaceDirectory>,
    /// 资料库 id，登记最早的在前。`providers` 按 id 排，保存入口的兜底按这个（ADR-0016）。
    pub registration_order: Vec<String>,
}
