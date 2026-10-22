//! 资料库的参考图接口：浏览、导入、显示、整理、永久删除与文件夹。

use super::*;

impl Library {
    /// 按查询浏览参考图，按导入先后从新到旧，keyset 分页。
    pub fn browse(&self, query: &BrowseQuery) -> Result<BrowsePage, Error> {
        types::browse(&self.inner, query)
    }

    /// 开始导入，立即返回任务。文件 I/O 与哈希在任务自己的线程里做。
    pub fn import(&self, source: ImportSource) -> ImportTask {
        self.import_with_options(source, ImportOptions::default())
    }

    /// 按本次选择导入；允许重导不清除内容版本的永久删除记忆。
    pub fn import_with_options(&self, source: ImportSource, options: ImportOptions) -> ImportTask {
        match &self.save_destination {
            Some(destination) => {
                import::start_to(self.inner.clone(), source, options, destination.clone())
            }
            None => import::start(self.inner.clone(), source, options),
        }
    }

    /// 订阅变更事件。事件在事务提交后才推送。
    pub fn events(&self) -> Receiver<LibraryEvent> {
        self.inner.hub.subscribe()
    }

    /// 参考图在目标像素宽度下的缩略图文件；缓存缺失时现场生成。
    pub fn thumbnail(&self, image_id: &str, target_px: u32) -> Result<PathBuf, Error> {
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        thumbnail::get(&self.inner, image_id, target_px)
    }

    /// 1:1 与放大时显示的文件（ADR-0005）：静态 SDR 原图交给 WebView2 直接显示；导入时标为
    /// 动图、HDR、Chromium 不能精确表示的 ICC 或 CMYK 的，给原尺寸的 `sdr` 派生图。
    /// 应用壳经 `thumb` 协议的 `<资料库 id>/<参考图 id>/full` 提供，看图界面只用这条路。
    pub fn display(&self, image_id: &str) -> Result<DisplayFile, Error> {
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        self.inner.display(image_id)
    }

    /// 查看器按目标宽度（转正后的设备像素）显示的文件：目标不小于原图宽度时同 [`Self::display`]；
    /// 更小时（适应窗口等）是精确尺寸的 `sdr` 派生图，不交给 Chromium 缩小（#47）。
    /// 应用壳经 `thumb` 协议的 `<资料库 id>/<参考图 id>/fit-<像素>` 提供。
    pub fn display_scaled(&self, image_id: &str, target_px: u32) -> Result<DisplayFile, Error> {
        if target_px == 0 {
            return Err(Error::InvalidDisplaySize);
        }
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        self.inner.display_scaled(image_id, target_px)
    }

    /// Receipt capability only: a detached provider and an exact live byte identity.
    /// Render from one verified immutable byte buffer; no mode, metadata or cache is changed.
    pub(crate) fn read_import_duplicate(
        &self,
        image_id: &str,
        sha256: &str,
        target_px: u32,
    ) -> Result<(Vec<u8>, String), Error> {
        use rusqlite::OptionalExtension;
        use sha2::{Digest, Sha256};
        if !self.inner.detached {
            return Err(Error::UnknownImage);
        }
        let width: Option<u32> = self
            .inner
            .readers
            .get()
            .query_row(
                "SELECT width FROM image WHERE id=?1 AND sha256=?2 AND deleted_at IS NULL",
                [image_id, sha256],
                |row| row.get(0),
            )
            .optional()?;
        let width = width.ok_or(Error::UnknownImage)?;
        let (description, _, original) = colour::get(&self.inner, image_id)?;
        let bytes = std::fs::read(original)?;
        if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
            return Err(Error::SourceChanged);
        }
        if target_px < width || description.needs_sdr_derivative() {
            let rendered = crate::fidelity::render::render_sdr(
                &bytes,
                target_px,
                crate::fidelity::DEFAULT_DOWNSCALE,
            )
            .map_err(Error::Undecodable)?;
            return Ok((rendered.bytes, rendered.mime.into()));
        }
        let mime = match description.format.as_str() {
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            "gif" => "image/gif",
            _ => "image/webp",
        };
        Ok((bytes, mime.into()))
    }

    /// 参考图的色彩描述（导入时记录）。浏览视角：被封印的图当作不存在。
    pub fn colour(&self, image_id: &str) -> Result<ColourDescription, Error> {
        self.inner
            .require_visible(&self.inner.readers.get(), image_id)?;
        colour::get(&self.inner, image_id).map(|(d, ..)| d)
    }

    /// 安全模式是否开启。
    pub fn safe_mode(&self) -> bool {
        self.inner.safe_mode()
    }

    /// 开关安全模式。状态变化时推送 [`LibraryEvent::SafeModeChanged`]：已取得的浏览结果、
    /// 计数、词表与详情都要重新读取。
    pub fn set_safe_mode(&self, on: bool) {
        if self.inner.safe_mode.swap(on, Ordering::SeqCst) != on {
            self.inner.hub.publish(LibraryEvent::SafeModeChanged {
                library_id: self.inner.info.id.clone(),
                on,
            });
        }
    }

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
