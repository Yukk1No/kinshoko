//! 资料库的参考图、文件夹与永久删除接口，以及不经浏览视角的显示文件（从 library/mod.rs 原样搬出）。

use super::*;

impl Library {
    /// 交出参考视角的句柄。每个打开的资料库只交出一次：应用壳在装配时取得，交给参考组与
    /// 桌面钉图（可以克隆）；之后再要只得到 `None`。
    pub fn take_reference_lens(&self) -> Option<ReferenceLens> {
        (!self.inner.reference_taken.swap(true, Ordering::SeqCst)).then(|| ReferenceLens {
            inner: self.inner.clone(),
        })
    }

    /// 对 `ids` 中的每张图按顺序应用 `edits`，一个事务内全部成功才提交，
    /// 返回这些图重新计算后的详情（按 `ids` 顺序、去重）。
    pub fn edit(&self, ids: &[String], edits: &[ImageEdit]) -> Result<Vec<ImageDetail>, Error> {
        edit::edit(&self.inner, ids, edits)
    }

    /// 永久删除的预览：`ids` 必须都在回收站里（浏览视角）。经参考组用途 port 查出用到它们的
    /// 参考组，给出令牌。参考组读不懂时无法核对，报错而不是当作没用到。
    pub fn preview_permanent_delete(
        &self,
        ids: &[String],
        usage: &dyn crate::reference_groups::ReferenceGroupUsage,
    ) -> Result<PermanentDeletePreview, Error> {
        permanent_delete::preview(&self.inner, ids, usage)
    }

    /// 清空回收站的预览（#114）：回收站里浏览视角看得见的全部图（安全模式下被封印的不算），
    /// 与 [`Self::preview_permanent_delete`] 相同的参考组核对与令牌；确认后交给
    /// [`Self::permanent_delete`]，沿用同一删除流程与 Eagle 重导记忆。
    pub fn preview_empty_trash(
        &self,
        usage: &dyn crate::reference_groups::ReferenceGroupUsage,
    ) -> Result<PermanentDeletePreview, Error> {
        permanent_delete::preview_trash(&self.inner, usage)
    }

    /// 永久删除回收站里的 `ids`：令牌须来自对同一组图的预览，且之后回收站、受影响的参考组与
    /// 安全模式都没变，否则为 [`Error::DeletePreviewStale`]，要重新预览。删掉参考图的记录、
    /// 整理结果、原文件与缩略图；参考组文件不改，成员与布局保留，核对时标为已删除。
    pub fn permanent_delete(
        &self,
        ids: &[String],
        token: &str,
        usage: &dyn crate::reference_groups::ReferenceGroupUsage,
    ) -> Result<(), Error> {
        permanent_delete::execute(&self.inner, ids, token, usage)
    }

    /// 单张参考图的详情。
    pub fn image(&self, image_id: &str) -> Result<ImageDetail, Error> {
        let conn = self.inner.readers.get();
        self.inner.require_visible(&conn, image_id)?;
        edit::detail(&conn, &self.inner.lens_filter(), image_id)
    }

    /// 侧栏：全部、回收站与文件夹树，计数只算可见的图。
    pub fn sidebar(&self) -> Result<Sidebar, Error> {
        sidebar::get(&self.inner)
    }

    /// 新建文件夹，放在 `parent` 下（`None` 为顶层）的最后，返回文件夹 id。
    pub fn create_folder(&self, name: &str, parent: Option<&str>) -> Result<String, Error> {
        folders::create(&self.inner, name, parent)
    }

    pub fn rename_folder(&self, folder_id: &str, name: &str) -> Result<(), Error> {
        folders::rename(&self.inner, folder_id, name)
    }

    /// 把文件夹（连同子文件夹）移到 `parent` 下（`None` 为顶层）的第 `position` 位；
    /// 超出时放在最后。不能移进它自己或它的子文件夹。
    pub fn move_folder(
        &self,
        folder_id: &str,
        parent: Option<&str>,
        position: u32,
    ) -> Result<(), Error> {
        folders::move_to(&self.inner, folder_id, parent, position)
    }

    /// 删除文件夹（#114），连同它的子文件夹。图片不删：只去掉这些文件夹的归属，没有其他文件夹的
    /// 图回到未归类（回收站里的图留在回收站）。来自 Eagle 的文件夹删掉后，重导不再把它建回来。
    pub fn delete_folder(&self, folder_id: &str) -> Result<(), Error> {
        folders::delete(&self.inner, folder_id)
    }

    /// 参考图的全部来源，按记录先后。之后并入查看器详情 `image(id)`。
    pub fn image_sources(&self, image_id: &str) -> Result<Vec<ImageSourceRecord>, Error> {
        let conn = self.inner.readers.get();
        self.inner.require_visible(&conn, image_id)?;
        let mut stmt = conn.prepare_cached(
            "SELECT source, location FROM image_source WHERE image_id = ?1
             ORDER BY recorded_at, rowid",
        )?;
        let sources = stmt
            .query_map([image_id], |row| {
                Ok(ImageSourceRecord {
                    source: row.get(0)?,
                    location: PathBuf::from(row.get::<_, String>(1)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if sources.is_empty() {
            return Err(Error::UnknownImage);
        }
        Ok(sources)
    }
}

impl Inner {
    /// [`Library::display`]，不经过浏览视角。
    pub(super) fn display(&self, image_id: &str) -> Result<DisplayFile, Error> {
        let (description, ..) = colour::get(self, image_id)?;
        if description.needs_sdr_derivative() {
            Ok(DisplayFile {
                route: DisplayRoute::SdrDerivative,
                path: thumbnail::full_size(self, image_id)?,
            })
        } else {
            Ok(DisplayFile {
                route: DisplayRoute::Original,
                path: self.original_path(image_id)?,
            })
        }
    }

    /// [`Library::display_scaled`]，不经过浏览视角。
    pub(super) fn display_scaled(
        &self,
        image_id: &str,
        target_px: u32,
    ) -> Result<DisplayFile, Error> {
        if target_px == 0 {
            return Err(Error::InvalidDisplaySize);
        }
        match display::scaled(self, image_id, target_px)? {
            Some(file) => Ok(file),
            None => self.display(image_id),
        }
    }

    /// 原文件位置，不经过浏览视角。
    pub(super) fn original_path(&self, image_id: &str) -> Result<PathBuf, Error> {
        let conn = self.readers.get();
        let rel: String = conn
            .query_row(
                "SELECT rel_path FROM image WHERE id = ?1",
                [image_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::UnknownImage)?;
        Ok(self.root.join(rel))
    }
}
