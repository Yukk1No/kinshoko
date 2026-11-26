//! 导入预览经可见性许可的三条流程：打开、关闭、分块读取。安全模式开启时导入回执里被封印的
//! 重复图只有经画师明确同意（打开预览）才显示；同意随任何一次安全模式提交、窗口关闭或下一次
//! 打开作废，作废之后不会再有下一块字节。

use std::ops::ControlFlow;

use super::{Grant, VisibilityPermit, WorkspaceSession};
use crate::CommandError;
use crate::library::Error;
use crate::safe_mode::LensStale;
use crate::tag_catalog::CatalogError;
use crate::workspace::ImportPreviewSession;

/// 每次进门发送的预览字节数：块与块之间出门，等着的关闭、作废与安全模式提交可以先进门。
pub const IMPORT_PREVIEW_CHUNK_BYTES: usize = 1023;

impl WorkspaceSession {
    /// 开始一次导入预览：之前的同意都作废。返回这次打开要用的授权；安全模式关着时得到
    /// [`LensStale`]（代次照样前进）。在打开之前、发起请求的线程上调用。
    pub fn begin_import_preview(&self) -> Result<Grant, LensStale> {
        self.visibility().begin_import_preview()
    }

    /// 打开 `library_id` 里导入任务 `task_id` 的预览。`grant` 来自 [`Self::begin_import_preview`]；
    /// 其间又开始了一次预览、预览被作废或安全模式提交过，得到 [`Error::LensChanged`]。
    pub fn open_import_preview(
        &self,
        grant: Grant,
        library_id: &str,
        task_id: &str,
    ) -> Result<ImportPreviewSession, CommandError> {
        VisibilityPermit::commit_with(
            self,
            grant,
            || Ok::<_, CommandError>(()),
            |permit, ()| {
                let session = self.with_resources(|w, d, c| {
                    w.open_import_preview(d, c, library_id, task_id, true)
                })?;
                // 窗口线程不进门就能作废（[`Self::fence_import_preview`]）：打开之后再复核一次。
                if permit.confirm(&grant).is_err() {
                    permit.close_import_preview(Some(&session.id));
                    return Err(Error::LensChanged.into());
                }
                Ok(session)
            },
        )
    }

    /// 关掉导入预览 `session_id`（`None` 时不论哪个）。晚到的、关旧预览的请求不作废新的同意。
    pub fn close_import_preview(&self, session_id: Option<&str>) {
        self.visibility().close_import_preview(session_id);
    }

    /// 读取预览 `session_id` 里的 `item_id`，按 [`IMPORT_PREVIEW_CHUNK_BYTES`] 分块交给 `send`，
    /// 最后一次是空块。`grant` 来自 [`Self::import_preview_grant`]，在发起请求时取。锁外解析，
    /// 门内完成；每一块都单独进门复核，作废之后不会再调用 `send`。
    pub fn read_import_preview(
        &self,
        grant: Grant,
        session_id: &str,
        item_id: &str,
        target_px: u32,
        mut send: impl FnMut(&[u8]) -> Result<(), CatalogError>,
    ) -> Result<(), CommandError> {
        grant.lens().confirm(&self.safe_mode)?;
        let content = VisibilityPermit::commit_with(
            self,
            grant,
            || {
                let request = self.with_resources(|w, d, c| {
                    w.prepare_import_preview(d, c, session_id, item_id, true, target_px)
                })?;
                request.resolve().map_err(CommandError::from)
            },
            |_, resolved| {
                self.with_resources(|w, d, c| w.complete_import_preview(d, c, resolved, true))
            },
        )?;
        let mut offset = 0;
        VisibilityPermit::stream(self, grant, |_| {
            let is_end = offset == content.bytes().len();
            offset = self
                .with_libraries(|device| {
                    Ok(device.commit_import_preview_chunk(
                        &content,
                        offset,
                        IMPORT_PREVIEW_CHUNK_BYTES,
                        true,
                        &mut send,
                    ))
                })?
                .map_err(CommandError::from)?;
            Ok::<_, CommandError>(if is_end {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            })
        })
    }
}
