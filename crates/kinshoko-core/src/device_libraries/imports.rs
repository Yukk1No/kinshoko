//! 导入任务的归属与查询。

use super::*;

pub(super) struct OwnedImport {
    pub(super) snapshot: ImportTaskSnapshot,
    pub(super) task: Option<ImportTask>,
    pub(super) library: Option<Arc<Library>>,
}
impl OwnedImport {
    pub(super) fn settle(&mut self, wait: bool) {
        if let Some(task) = &self.task {
            self.snapshot.progress = task.progress();
        }
        if self
            .task
            .as_ref()
            .is_some_and(|task| wait || task.is_finished())
        {
            let report = self.task.take().expect("running task").wait();
            self.snapshot.report = Some(report);
            self.library = None;
        }
    }
    pub(super) fn cancel(&self) {
        if let Some(task) = &self.task {
            task.cancel();
        }
    }
    /// 内容已处理完、定义发布还没结束：导入在收尾。
    pub(super) fn is_finishing(&self) -> bool {
        self.snapshot.finishing && self.task.as_ref().is_none_or(ImportTask::is_finished)
    }
}

impl DeviceLibraries {
    pub fn start_import(
        &mut self,
        library_id: &str,
        source: ImportSource,
    ) -> Result<String, DeviceLibraryError> {
        self.start_import_with_options(library_id, source, ImportOptions::default())
    }

    /// 为这个任务固定导入选择；保持既有 start_import 的默认入口。
    pub fn start_import_with_options(
        &mut self,
        library_id: &str,
        source: ImportSource,
        options: ImportOptions,
    ) -> Result<String, DeviceLibraryError> {
        self.start_import_to(
            SaveDestination {
                library_id: library_id.into(),
                folder_id: None,
            },
            source,
            options,
        )
    }

    /// A task captures one destination and retains that provider until it settles.
    pub fn start_import_to(
        &mut self,
        destination: SaveDestination,
        source: ImportSource,
        options: ImportOptions,
    ) -> Result<String, DeviceLibraryError> {
        let library = self.write(&destination.library_id)?;
        library
            .validate_destination(&destination)
            .map_err(DeviceLibraryError::Library)?;
        fn folder_path(
            nodes: &[crate::library::FolderNode],
            id: &str,
            prefix: &str,
        ) -> Option<String> {
            for node in nodes {
                let path = if prefix.is_empty() {
                    node.name.clone()
                } else {
                    format!("{prefix} / {}", node.name)
                };
                if node.id == id {
                    return Some(path);
                }
                if let Some(found) = folder_path(&node.children, id, &path) {
                    return Some(found);
                }
            }
            None
        }
        let folder_name = match &destination.folder_id {
            None => "未归类".into(),
            Some(id) => folder_path(
                &library
                    .sidebar()
                    .map_err(DeviceLibraryError::Library)?
                    .folders,
                id,
                "",
            )
            .ok_or(DeviceLibraryError::Library(
                crate::library::Error::UnknownFolder,
            ))?,
        };
        self.writers
            .insert(destination.library_id.clone(), library.clone());
        let task = library
            .import_to(source, options, &destination)
            .map_err(DeviceLibraryError::Library)?;
        let id = task.id().to_owned();
        self.tasks.insert(
            id.clone(),
            OwnedImport {
                snapshot: ImportTaskSnapshot {
                    task_id: id.clone(),
                    destination,
                    library_name: library.info().name.clone(),
                    folder_name,
                    progress: task.progress(),
                    report: None,
                    finishing: false,
                    warnings: Vec::new(),
                },
                task: Some(task),
                library: Some(library),
            },
        );
        Ok(id)
    }

    pub fn cancel_import(&self, library_id: &str, task_id: &str) -> Result<(), DeviceLibraryError> {
        if let Some(task) = self.tasks.get(task_id) {
            if task.snapshot.destination.library_id != library_id {
                return Err(DeviceLibraryError::StaleLibrary);
            }
            task.cancel();
        }
        Ok(())
    }

    /// Includes completed real receipts until the user dismisses them. Polling never
    /// waits for a running task or changes the active provider.
    pub fn import_tasks(&mut self) -> Vec<ImportTaskSnapshot> {
        for task in self.tasks.values_mut() {
            task.settle(false);
        }
        let mut snapshots: Vec<_> = self.tasks.values().map(|t| t.snapshot.clone()).collect();
        snapshots.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        snapshots
    }

    pub fn import_task(&mut self, task_id: &str) -> Option<ImportTaskSnapshot> {
        let task = self.tasks.get_mut(task_id)?;
        task.settle(false);
        Some(task.snapshot.clone())
    }

    pub fn dismiss_import(
        &mut self,
        library_id: &str,
        task_id: &str,
    ) -> Result<(), DeviceLibraryError> {
        if let Some(task) = self.tasks.get_mut(task_id) {
            task.settle(false);
            if task.snapshot.destination.library_id != library_id
                || task.task.is_some()
                || task.snapshot.finishing
            {
                return Err(DeviceLibraryError::StaleLibrary);
            }
        }
        if self
            .import_preview
            .as_ref()
            .is_some_and(|preview| preview.task_id == task_id)
        {
            self.close_import_preview(None);
        }
        self.tasks.remove(task_id);
        self.finished.advance();
        Ok(())
    }

    /// The adapter owns post-import publication; its result stays on the original receipt.
    pub fn defer_import_completion(&mut self, task_id: &str) -> Result<(), DeviceLibraryError> {
        let task = self
            .tasks
            .get_mut(task_id)
            .ok_or(DeviceLibraryError::StaleLibrary)?;
        task.snapshot.finishing = true;
        Ok(())
    }
    pub fn complete_import_publication(
        &mut self,
        library_id: &str,
        task_id: &str,
        warning: Option<String>,
    ) -> Result<(), DeviceLibraryError> {
        let task = self
            .tasks
            .get_mut(task_id)
            .ok_or(DeviceLibraryError::StaleLibrary)?;
        if task.snapshot.destination.library_id != library_id {
            return Err(DeviceLibraryError::StaleLibrary);
        }
        task.settle(false);
        task.snapshot.finishing = false;
        if let Some(warning) = warning {
            task.snapshot.warnings.push(warning);
        }
        self.finished.advance();
        Ok(())
    }
}
