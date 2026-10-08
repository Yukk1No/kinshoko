//! 跨越前后端边界的资料库类型，以及浏览查询。

use std::path::PathBuf;

use rusqlite::params_from_iter;
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Error, Inner, LIVE, filter, lens, rating, thumbnail};
use crate::search::ConditionTree;

/// 资料库身份与位置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryInfo {
    pub id: String,
    pub name: String,
    #[ts(type = "string")]
    pub root: PathBuf,
}

/// 浏览范围。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum BrowseScope {
    /// 全部可见的图（不含回收站）。
    #[default]
    All,
    /// 直接放在某个文件夹里的可见图（不含子文件夹）。
    Folder { id: String },
    /// 某个文件夹及其全部子文件夹中的图，每张图只计算一次。
    FolderTree { id: String },
    /// 没有任何文件夹归属的可见图。
    Unassigned,
    /// 回收站：可恢复删除的图。
    Trash,
}

/// 一次浏览请求：范围＋条件树，keyset 分页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowseQuery {
    #[serde(default)]
    pub scope: BrowseScope,
    /// Search 给出的条件树（#54）；为空时是范围内的全部参考图。
    #[serde(default)]
    pub conditions: ConditionTree,
    /// 上一页返回的 `nextCursor`；第一页为空。
    #[serde(default)]
    pub cursor: Option<String>,
    /// 每页最多几张，上限 1000。
    pub limit: u32,
    /// 缩略图要显示的设备像素宽度；返回的地址按档位取整，不放大原图。
    pub thumbnail_px: u32,
}

/// 图片墙上的一张卡片。尺寸取自资料库记录（已按 EXIF 方向转正），界面据此布局。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageCard {
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// 缩略图地址：`<资料库 id>/<参考图 id>/<像素档位>`，由应用壳映射到自定义协议。
    pub thumbnail: String,
    /// 含成人内容（有效分级为 questionable 或 explicit）：打开安全模式时会被封印。
    /// 安全模式开启时浏览结果里没有这样的图，界面据此在开启的一瞬间先把它们遮住。
    pub adult: bool,
}

/// 一页浏览结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowsePage {
    pub cards: Vec<ImageCard>,
    /// 还有下一页时给出游标。
    pub next_cursor: Option<String>,
    /// 范围内的总张数。
    pub total: u32,
}

/// 导入来源：若干文件或文件夹（含子文件夹）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportSource {
    #[ts(type = "string[]")]
    pub paths: Vec<PathBuf>,
}

impl ImportSource {
    /// 只读识别来源是否含 Eagle 库或条目，供导入开始前询问本次选择。
    /// 包含选择的父文件夹；不注册来源、不解码图片，也不写入资料库。
    pub fn contains_eagle(&self) -> bool {
        super::import::contains_eagle(self)
    }
}

/// Eagle 曾永久删除的同一内容在本次任务中的处理方式，不改写长期删除记忆。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EagleDeletedContentChoice {
    /// 默认记住删除决定，跳过没有本库副本的同一内容。
    #[default]
    SkipDeleted,
    /// 画师明确允许这一次重新导入；下一次任务仍使用默认选择。
    AllowThisImport,
}

/// 单次导入的选择；原有 [`super::Library::import`] 继续使用默认值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct ImportOptions {
    pub eagle_deleted_content: EagleDeletedContentChoice,
}

/// 导入进度：已处理几项、共几项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportProgress {
    pub done: u32,
    pub total: u32,
}

/// 一项导入的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ImportOutcome {
    /// 新建了参考图。
    #[serde(rename_all = "camelCase")]
    Imported { image_id: String },
    /// 与资料库中已有原图字节相同，合并为同一条记录并保留来源。
    #[serde(rename_all = "camelCase")]
    Merged { image_id: String },
    /// 已迁入的 Eagle 条目再次导入且内容未变：只刷新 Eagle 来源层，人工整理不变。
    #[serde(rename_all = "camelCase")]
    Refreshed { image_id: String },
    /// Eagle 条目的原图内容变了：新内容成为新的参考图，旧版本连同它的整理保留。
    #[serde(rename_all = "camelCase")]
    NewVersion {
        image_id: String,
        previous_image_id: String,
    },
    /// 与本库回收站的原图字节相同，来源信息可刷新，删除状态保持，恢复由画师决定。
    #[serde(rename_all = "camelCase")]
    TrashDuplicate { image_id: String },
    /// Eagle 同一字节内容曾在本资料库永久删除，本次按默认删除决定跳过。
    SkippedDeleted,
    /// 不支持的格式。
    Unsupported,
    /// 读取失败，附原因。
    ReadFailed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportItem {
    #[ts(type = "string")]
    pub path: PathBuf,
    pub outcome: ImportOutcome,
}

/// 导入任务的逐项结果。取消时只列出取消前处理过的项。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportReport {
    /// A boolean prompt only. The ordinary receipt never exposes the sealed subset size.
    pub sealed_duplicates: bool,
    /// Success details are intentionally coarsened together so subtraction cannot reveal a subset.
    pub private_summary: bool,
    pub trash_duplicates: bool,
    pub items: Vec<ImportItem>,
    pub cancelled: bool,
    /// 导入器识别到了 Eagle 来源，与画师使用的入口无关。
    pub from_eagle: bool,
    /// 这次迁入的 Eagle 资料库里已经不存在、但本库保留了副本的条目数。
    pub eagle_missing: u32,
    /// 像是已登记 Eagle 来源搬了家的新位置。画师确认前不迁入这些位置的任何条目，
    /// 确认见 [`super::Library::confirm_eagle_location`]。
    pub eagle_relocations: Vec<EagleRelocation>,
}

/// 新位置疑似已登记的 Eagle 来源搬了家：已绑定条目至少一半出现在新位置。只是提议。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EagleRelocation {
    /// 疑似搬家的已登记来源。
    pub source_id: String,
    /// 登记的位置。
    #[ts(type = "string")]
    pub from: PathBuf,
    /// 这次导入的新位置。
    #[ts(type = "string")]
    pub to: PathBuf,
    /// 已绑定条目出现在新位置的比例（百分比，向下取整）。
    pub overlap_percent: u32,
}

/// 画师对疑似搬家位置的确认。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum EagleLocationChoice {
    /// 就是这个已登记来源搬了家：沿用登记，之后的重导只刷新。
    #[serde(rename_all = "camelCase")]
    Moved { source_id: String },
    /// 是另一个来源：单独登记，相同原图合并进已有记录。
    Separate,
}

impl ImportOutcome {
    /// 这一项落到的参考图；没有进库时为 `None`。
    pub fn image_id(&self) -> Option<&str> {
        match self {
            ImportOutcome::Imported { image_id }
            | ImportOutcome::Merged { image_id }
            | ImportOutcome::Refreshed { image_id }
            | ImportOutcome::NewVersion { image_id, .. }
            | ImportOutcome::TrashDuplicate { image_id } => Some(image_id),
            _ => None,
        }
    }
}

impl ImportReport {
    /// Safe transport fallback before all-provider receipt projection is available.
    /// Failures keep their real retry paths; successful content identities/names/counts do not leave.
    pub fn without_content_details(mut self) -> Self {
        self.private_summary = true;
        self.trash_duplicates |= self
            .items
            .iter()
            .any(|item| matches!(item.outcome, ImportOutcome::TrashDuplicate { .. }));
        self.items.retain(|item| {
            matches!(
                item.outcome,
                ImportOutcome::ReadFailed { .. }
                    | ImportOutcome::Unsupported
                    | ImportOutcome::SkippedDeleted
            )
        });
        self.eagle_missing = 0;
        self
    }
    /// 只含读取失败项的导入来源，供重试；没有失败项时为 `None`。
    /// 重试不会重复创建已成功的图：字节相同的原图总是合并为同一条记录。
    pub fn retry_source(&self) -> Option<ImportSource> {
        let paths: Vec<PathBuf> = self
            .items
            .iter()
            .filter(|i| matches!(i.outcome, ImportOutcome::ReadFailed { .. }))
            .map(|i| i.path.clone())
            .collect();
        (!paths.is_empty()).then_some(ImportSource { paths })
    }
}

/// 打开资料库时的对账结果。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecoveryReport {
    /// 上次中断、已撤回的导入项（原图所在位置），可以重新导入。
    #[ts(type = "string[]")]
    pub interrupted: Vec<PathBuf>,
    /// 原文件夹里没有参考图引用的文件（相对资料库根目录）。只报告，不删除。
    #[ts(type = "string[]")]
    pub orphans: Vec<PathBuf>,
    /// 清掉的未发布暂存文件个数。
    pub discarded_staging: u32,
}

/// 参考图的一条来源：从哪里、以哪种方式进的库。字节相同的图各次导入的来源都保留。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSourceRecord {
    /// 来源标记，例如普通文件导入为 `file`。
    pub source: String,
    /// 导入时原图所在位置。
    pub location: PathBuf,
}

const MAX_LIMIT: u32 = 1000;

/// 分页游标（#77 S4）。对外是不透明字符串，记下它所依据的结果集：资料库、浏览视角（安全模式）、
/// 列表修订号、条件查找时的词表修订号与查询指纹，以及最后一张的 `seq`。任何一项与当前不同，
/// 接着翻都可能遗漏或重复，于是明确失效（[`Error::CursorExpired`]），调用方从第一页重读。
#[derive(Debug, PartialEq, Eq)]
struct Cursor {
    library: String,
    safe: bool,
    /// 列表修订号：参考图增删、回收站、文件夹成员、备注、跨过成人线的分级变化时前进。
    list: i64,
    /// 有条件时的词表修订号（有效标签变化会改变条件结果）；没有条件时恒为 0，
    /// 后台打标不打断浏览全部图的分页。
    vocabulary: i64,
    query: String,
    seq: i64,
}

impl Cursor {
    const VERSION: &'static str = "v1";

    fn encode(&self) -> String {
        format!(
            "{}.{}.{}.{}.{}.{}.{}",
            Self::VERSION,
            self.library,
            if self.safe { "s" } else { "o" },
            self.list,
            self.vocabulary,
            self.query,
            self.seq
        )
    }

    fn decode(text: &str) -> Result<Cursor, Error> {
        let parts: Vec<&str> = text.split('.').collect();
        let [version, library, lens, list, vocabulary, query, seq] = parts[..] else {
            return Err(Error::InvalidCursor);
        };
        let number = |s: &str| s.parse::<i64>().map_err(|_| Error::InvalidCursor);
        if version != Self::VERSION {
            return Err(Error::InvalidCursor);
        }
        let safe = match lens {
            "s" => true,
            "o" => false,
            _ => return Err(Error::InvalidCursor),
        };
        Ok(Cursor {
            library: library.to_owned(),
            safe,
            list: number(list)?,
            vocabulary: number(vocabulary)?,
            query: query.to_owned(),
            seq: number(seq)?,
        })
    }
}

/// 查询（范围＋条件树）的指纹：同一查询才接得上同一个游标。
fn query_fingerprint(query: &BrowseQuery) -> Result<String, Error> {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_vec(&(&query.scope, &query.conditions))
        .map_err(|e| Error::Io(std::io::Error::other(e)))?;
    let digest = Sha256::digest(json);
    Ok(digest[..12].iter().map(|b| format!("{b:02x}")).collect())
}

pub(super) fn browse(inner: &Inner, query: &BrowseQuery) -> Result<BrowsePage, Error> {
    let cursor = query.cursor.as_deref().map(Cursor::decode).transpose()?;
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let tier = thumbnail::tier(query.thumbnail_px);
    let library_id = &inner.info.id;
    // 视角只读一次：过滤条件与游标记下的视角一致。
    let safe = inner.safe_mode();
    let fingerprint = query_fingerprint(query)?;

    // 范围条件在前，条件树在后；参数按出现顺序编号。浏览视角的过滤（安全模式）加在中间。
    let mut args: Vec<Value> = Vec::new();
    let mut conn = inner.readers.get();
    // Scope validation, structure, revisions and rows share the same read transaction.
    let tx = conn.transaction()?;
    let scope = scope_sql(&tx, &query.scope, &mut args)?;
    let conditions = filter::sql(&query.conditions, &mut args);
    let filter = format!("{scope} AND {} AND {conditions}", lens::lens_filter(safe));
    let list: i64 = tx.query_row("SELECT value FROM list_revision", [], |r| r.get(0))?;
    let vocabulary: i64 = if query.conditions.conditions.is_empty() {
        0
    } else {
        tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?
    };
    let after = match cursor {
        None => i64::MAX,
        Some(c) => {
            let current = c.library == *library_id
                && c.safe == safe
                && c.list == list
                && c.vocabulary == vocabulary
                && c.query == fingerprint;
            if !current {
                return Err(Error::CursorExpired);
            }
            c.seq
        }
    };
    // 计数与分页用同一个筛选，结果与计数一致。
    let total: u32 = tx.query_row(
        &format!("SELECT COUNT(*) FROM image WHERE {filter}"),
        params_from_iter(&args),
        |r| r.get(0),
    )?;
    let n = args.len();
    args.push(Value::Integer(after));
    args.push(Value::Integer(i64::from(limit) + 1));
    let mut rows = {
        let mut stmt = tx.prepare_cached(&format!(
            "SELECT seq, id, width, height, {} FROM image WHERE {filter} AND seq < ?{}
             ORDER BY seq DESC LIMIT ?{}",
            rating::adult_sql("image.id"),
            n + 1,
            n + 2
        ))?;
        stmt.query_map(params_from_iter(&args), |row| {
            let id: String = row.get(1)?;
            Ok((
                row.get::<_, i64>(0)?,
                ImageCard {
                    thumbnail: format!("{library_id}/{id}/{tier}"),
                    id,
                    width: row.get(2)?,
                    height: row.get(3)?,
                    adult: row.get(4)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    tx.finish()?;
    let next_cursor = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|(seq, _)| {
            Cursor {
                library: library_id.clone(),
                safe,
                list,
                vocabulary,
                query: fingerprint,
                seq: *seq,
            }
            .encode()
        })
    } else {
        None
    };
    Ok(BrowsePage {
        cards: rows.into_iter().map(|(_, card)| card).collect(),
        next_cursor,
        total,
    })
}

/// Shared scope interpreter for local browsing and detached workspace providers.
pub(super) fn scope_sql(
    conn: &rusqlite::Connection,
    scope: &BrowseScope,
    args: &mut Vec<Value>,
) -> Result<String, Error> {
    Ok(match scope {
        BrowseScope::All => LIVE.to_owned(),
        BrowseScope::Trash => format!("NOT ({LIVE})"),
        BrowseScope::Unassigned => {
            format!("{LIVE} AND NOT EXISTS (SELECT 1 FROM folder_member WHERE image_id = image.id)")
        }
        BrowseScope::Folder { id } | BrowseScope::FolderTree { id } => {
            super::folders::ensure_folder(conn, id)?;
            args.push(Value::Text(id.clone()));
            let parameter = args.len();
            let folders = if matches!(scope, BrowseScope::FolderTree { .. }) {
                format!(
                    "IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM folder WHERE id=?{parameter} UNION ALL SELECT folder.id FROM folder JOIN descendants ON folder.parent_id=descendants.id) SELECT id FROM descendants)"
                )
            } else {
                format!("=?{parameter}")
            };
            format!(
                "{LIVE} AND image.id IN (SELECT image_id FROM folder_member WHERE folder_id {folders})"
            )
        }
    })
}

/// 原图在 1:1 与放大时怎样显示（ADR-0005）。由导入时记录的色彩描述决定
/// （[`crate::fidelity::ColourDescription::needs_sdr_derivative`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DisplayRoute {
    /// 原文件交给 WebView2 直接解释。
    Original,
    /// 原尺寸的 `sdr` 派生图：动图（首帧）、HDR、Chromium 不能精确表示的 ICC 与 CMYK。
    SdrDerivative,
}

/// 1:1 与放大时要显示的文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayFile {
    pub route: DisplayRoute,
    pub path: PathBuf,
}
