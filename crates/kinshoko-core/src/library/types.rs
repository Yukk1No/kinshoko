//! 跨越前后端边界的资料库类型，以及浏览查询。

use std::path::PathBuf;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Error, Inner, thumbnail};

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

/// 浏览范围。文件夹与回收站随后续切片加入。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BrowseScope {
    #[default]
    All,
}

/// 一次浏览请求。条件树与排序随查找切片加入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowseQuery {
    #[serde(default)]
    pub scope: BrowseScope,
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
    pub items: Vec<ImportItem>,
    pub cancelled: bool,
}

impl ImportReport {
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

pub(super) fn browse(inner: &Inner, query: &BrowseQuery) -> Result<BrowsePage, Error> {
    let BrowseScope::All = query.scope;
    let after = match &query.cursor {
        None => i64::MAX,
        Some(c) => c.parse::<i64>().map_err(|_| Error::InvalidCursor)?,
    };
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let tier = thumbnail::tier(query.thumbnail_px);
    let library_id = &inner.info.id;

    let conn = inner.readers.get();
    let total: u32 = conn.query_row("SELECT COUNT(*) FROM image", [], |r| r.get(0))?;
    let mut stmt = conn.prepare_cached(
        "SELECT seq, id, width, height FROM image WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![after, limit + 1], |row| {
        let id: String = row.get(1)?;
        Ok((
            row.get::<_, i64>(0)?,
            ImageCard {
                thumbnail: format!("{library_id}/{id}/{tier}"),
                id,
                width: row.get(2)?,
                height: row.get(3)?,
            },
        ))
    })?;
    let mut rows = rows.collect::<Result<Vec<_>, _>>()?;
    let next_cursor = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|(seq, _)| seq.to_string())
    } else {
        None
    };
    Ok(BrowsePage {
        cards: rows.into_iter().map(|(_, card)| card).collect(),
        next_cursor,
        total,
    })
}
