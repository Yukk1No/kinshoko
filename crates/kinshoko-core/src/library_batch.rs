//! 跨图库的批量整理（ADR-0008，#112）。界面上的选择可以跨多个图库（例如在“全部图片”里），
//! 后端却只为一个图库持有可写句柄：按图库分组，逐组切换可写句柄执行；某组失败（图库断连、
//! 导入收尾等不到、预览过期）不影响其他组，结果按图库逐一报告。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::command_error::{CommandError, ErrorKind};
use crate::library::PermanentDeletePreview;

/// 批量操作里的一张图：它所在的图库与在那个图库里的 id。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryTarget {
    pub library_id: String,
    pub image_id: String,
}

/// 同一个图库里要一起处理的图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryBatch {
    pub library_id: String,
    pub image_ids: Vec<String>,
}

/// 一个图库的永久删除预览；这个图库核对不了时只有 `error`。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryDeletePreview {
    pub library_id: String,
    pub preview: Option<PermanentDeletePreview>,
    #[ts(as = "Option<ErrorKind>")]
    pub error: Option<CommandError>,
}

/// 按预览确认后交回的一组：图库、它的图与预览令牌。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryDeleteToken {
    pub library_id: String,
    pub image_ids: Vec<String>,
    pub token: String,
}

/// 一个图库这次没有完成的原因；全部完成时批量结果为空。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryBatchFailure {
    pub library_id: String,
    #[ts(as = "ErrorKind")]
    pub error: CommandError,
}

/// 按图库分组，图库按第一次出现的先后，组内去重并保持先后。
pub fn group_by_library(targets: &[LibraryTarget]) -> Vec<LibraryBatch> {
    let mut batches: Vec<LibraryBatch> = Vec::new();
    for target in targets {
        let batch = match batches
            .iter()
            .position(|batch| batch.library_id == target.library_id)
        {
            Some(index) => &mut batches[index],
            None => {
                batches.push(LibraryBatch {
                    library_id: target.library_id.clone(),
                    image_ids: Vec::new(),
                });
                batches.last_mut().expect("刚加入")
            }
        };
        if !batch.image_ids.contains(&target.image_id) {
            batch.image_ids.push(target.image_id.clone());
        }
    }
    batches
}

/// 逐组执行，一组失败不影响后面的组；返回每组与它的结果，顺序同输入。
/// `run` 负责按需切换可写句柄（等导入收尾）并执行这一组。
pub fn each_library<B, T, E>(
    batches: impl IntoIterator<Item = B>,
    mut run: impl FnMut(&B) -> Result<T, E>,
) -> Vec<(B, Result<T, E>)> {
    batches
        .into_iter()
        .map(|batch| {
            let result = run(&batch);
            (batch, result)
        })
        .collect()
}
