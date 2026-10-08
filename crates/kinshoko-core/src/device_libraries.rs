//! 应用壳的多资料库管理：登记表保存位置，同一时间只有一个活动资料库。

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;

use crate::library::{
    ImportOptions, ImportProgress, ImportReport, ImportSource, ImportTask, SaveDestination,
};
use crate::{DeviceRegistry, Library, RegisteredLibrary};

/// 给画师看的登记与切换错误。
#[derive(Debug)]
pub enum DeviceLibraryError {
    Registry(std::io::Error),
    Library(crate::library::Error),
    UnknownLibrary,
    StaleLibrary,
    IdentityChanged { root: PathBuf },
    Unavailable { root: PathBuf, reason: String },
}

impl fmt::Display for DeviceLibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Registry(e) => write!(f, "无法保存本设备的资料库登记：{e}"),
            Self::Library(e) => e.fmt(f),
            Self::UnknownLibrary => write!(f, "本设备没有登记这个资料库"),
            Self::StaleLibrary => write!(f, "资料库已切换或关闭，请在当前资料库重新操作"),
            Self::IdentityChanged { root } => write!(
                f,
                "{} 已是另一个资料库，请选择正确位置重新登记",
                root.display()
            ),
            Self::Unavailable { root, reason } => write!(
                f,
                "资料库暂时不可用：{}。请确认移动盘已连接；资料库搬家后请选择新位置重新登记。原因：{reason}",
                root.display()
            ),
        }
    }
}

impl std::error::Error for DeviceLibraryError {}

impl From<std::io::Error> for DeviceLibraryError {
    fn from(error: std::io::Error) -> Self {
        Self::Registry(error)
    }
}

/// 已登记资料库及本次检查的不可用原因；不可用的登记仍保留，移动盘接回后可重试。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LibraryRegistration {
    pub library: RegisteredLibrary,
    pub unavailable: Option<String>,
}

/// A real task receipt bound to its chosen destination, not to current browsing.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportTaskSnapshot {
    pub task_id: String,
    pub destination: SaveDestination,
    pub library_name: String,
    pub folder_name: String,
    pub progress: ImportProgress,
    pub report: Option<ImportReport>,
    pub finishing: bool,
    pub warnings: Vec<String>,
}

struct OwnedImport {
    snapshot: ImportTaskSnapshot,
    task: Option<ImportTask>,
    library: Option<Arc<Library>>,
}
impl OwnedImport {
    fn settle(&mut self, wait: bool) {
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
    fn cancel(&self) {
        if let Some(task) = &self.task {
            task.cancel();
        }
    }
}

/// 当前进程的资料库与本设备登记。调用方将它放在互斥锁中，串行处理切换。
pub struct DeviceLibraries {
    device: DeviceRegistry,
    current: Option<Arc<Library>>,
    tasks: HashMap<String, OwnedImport>,
    /// Writable providers are reused without changing current or last-opened state.
    writers: HashMap<String, Arc<Library>>,
}

impl DeviceLibraries {
    /// 读取登记表；恢复上次打开的库由调用方显式触发，以便展示不可用原因。
    pub fn open(dir: &Path) -> Result<Self, DeviceLibraryError> {
        Ok(Self {
            device: DeviceRegistry::open(dir)?,
            current: None,
            tasks: HashMap::new(),
            writers: HashMap::new(),
        })
    }

    pub fn libraries(&self) -> &[RegisteredLibrary] {
        self.device.libraries()
    }

    pub fn registrations(&self) -> Vec<LibraryRegistration> {
        Self::inspect_registrations(self.libraries())
    }

    /// 检查登记表的副本。调用方先放开活动库状态锁，网络盘的 I/O 不阻塞正常库操作。
    pub fn inspect_registrations(libraries: &[RegisteredLibrary]) -> Vec<LibraryRegistration> {
        libraries
            .iter()
            .map(|library| LibraryRegistration {
                library: library.clone(),
                unavailable: Self::inspect(&library.root, Some(&library.id))
                    .err()
                    .map(|error| error.to_string()),
            })
            .collect()
    }

    pub fn current(&self) -> Option<Arc<Library>> {
        self.current.clone()
    }

    /// 建立、登记并切换到新资料库。
    pub fn create(&mut self, root: &Path, name: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        let library = Library::create(root, name).map_err(DeviceLibraryError::Library)?;
        self.activate(library)
    }

    /// 请求必须带上界面正在操作的资料库身份，旧请求不能取得新资料库。
    pub fn require(&self, library_id: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        self.current()
            .filter(|library| library.info().id == library_id)
            .ok_or(DeviceLibraryError::StaleLibrary)
    }

    /// Resolve a registered content provider without switching the active library or
    /// changing last-opened state. Every reader is isolated, read-only and identity-checked.
    pub fn read(&self, library_id: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        let registration = self
            .libraries()
            .iter()
            .find(|entry| entry.id == library_id)
            .ok_or(DeviceLibraryError::UnknownLibrary)?;

        Self::inspect(&registration.root, Some(library_id))?;
        Library::open_read_only(&registration.root, library_id)
            .map(Arc::new)
            .map_err(|error| DeviceLibraryError::Unavailable {
                root: registration.root.clone(),
                reason: error.to_string(),
            })
    }

    /// Resolve an explicitly selected registered provider for writing. Every action
    /// rechecks its on-disk identity and path; a matching duplicate in another library
    /// is never a replacement target. Reuse avoids reopening a provider with live work.
    pub fn write(&mut self, library_id: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        let registration = self
            .libraries()
            .iter()
            .find(|r| r.id == library_id)
            .cloned()
            .ok_or(DeviceLibraryError::UnknownLibrary)?;
        Self::inspect(&registration.root, Some(library_id))?;
        if let Some(library) = self
            .current
            .as_ref()
            .filter(|library| library.info().id == library_id)
            .or_else(|| self.writers.get(library_id))
            && std::fs::canonicalize(&library.info().root)
                .ok()
                .is_some_and(|root| Some(root) == std::fs::canonicalize(&registration.root).ok())
        {
            let library = library.clone();
            self.writers.insert(library_id.into(), library.clone());
            return Ok(library);
        }
        let library =
            Library::open(&registration.root).map_err(|error| DeviceLibraryError::Unavailable {
                root: registration.root.clone(),
                reason: error.to_string(),
            })?;
        if library.info().id != library_id {
            return Err(DeviceLibraryError::IdentityChanged {
                root: registration.root,
            });
        }
        let library = Arc::new(library);
        self.writers.insert(library_id.into(), library.clone());
        Ok(library)
    }

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
        self.tasks.remove(task_id);
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
        Ok(())
    }

    pub fn restore_last_opened(&mut self) -> Result<Option<Arc<Library>>, DeviceLibraryError> {
        if self.current.is_some() {
            return Ok(self.current());
        }
        let Some(id) = self.device.last_opened().map(|library| library.id.clone()) else {
            return Ok(None);
        };
        self.switch(&id).map(Some)
    }

    /// 登记所选位置并打开；同一身份再次登记时更新位置。
    pub fn register(&mut self, root: &Path) -> Result<Arc<Library>, DeviceLibraryError> {
        self.open_at(root, None)
    }

    fn open_at(
        &mut self,
        root: &Path,
        expected: Option<&str>,
    ) -> Result<Arc<Library>, DeviceLibraryError> {
        let info = Self::inspect(root, expected)?;
        if let Some(current) = &self.current
            && info.id == current.info().id
            && std::fs::canonicalize(root)
                .ok()
                .is_some_and(|root| Some(root) == std::fs::canonicalize(&current.info().root).ok())
        {
            self.device.register(current.info())?;
            return Ok(current.clone());
        }
        if let Some(library) = self
            .writers
            .get(&info.id)
            .filter(|library| {
                std::fs::canonicalize(root).ok().is_some_and(|root| {
                    Some(root) == std::fs::canonicalize(&library.info().root).ok()
                })
            })
            .cloned()
        {
            self.device.register(library.info())?;
            self.current = Some(library.clone());
            return Ok(library);
        }
        let library = Library::open(root).map_err(|error| DeviceLibraryError::Unavailable {
            root: root.to_path_buf(),
            reason: error.to_string(),
        })?;
        if expected.is_some_and(|id| id != library.info().id) {
            return Err(DeviceLibraryError::IdentityChanged {
                root: root.to_path_buf(),
            });
        }
        self.activate(library)
    }

    /// 只登记、不切换（恢复出的资料库，#69）：活动资料库与“上次打开”都不变。
    pub fn add_registration(
        &mut self,
        root: &Path,
    ) -> Result<RegisteredLibrary, DeviceLibraryError> {
        let info = Self::inspect(root, None)?;
        self.device.add(&info)?;
        Ok(RegisteredLibrary {
            id: info.id,
            name: info.name,
            root: info.root,
        })
    }

    pub fn switch(&mut self, id: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        let root = self
            .device
            .libraries()
            .iter()
            .find(|library| library.id == id)
            .ok_or(DeviceLibraryError::UnknownLibrary)?
            .root
            .clone();
        self.open_at(&root, Some(id))
    }

    fn inspect(
        root: &Path,
        expected: Option<&str>,
    ) -> Result<crate::library::LibraryInfo, DeviceLibraryError> {
        let info = Library::inspect(root).map_err(|error| DeviceLibraryError::Unavailable {
            root: root.to_path_buf(),
            reason: error.to_string(),
        })?;
        if expected.is_some_and(|id| id != info.id) {
            return Err(DeviceLibraryError::IdentityChanged {
                root: root.to_path_buf(),
            });
        }
        Ok(info)
    }

    pub fn unregister(&mut self, id: &str) -> Result<(), DeviceLibraryError> {
        self.device.unregister(id)?;
        if let Some(library) = self.writers.get(id).or_else(|| {
            self.current
                .as_ref()
                .filter(|library| library.info().id == id)
        }) {
            library.revoke_save_destination();
        }
        for task in self
            .tasks
            .values()
            .filter(|t| t.snapshot.destination.library_id == id)
        {
            task.cancel();
        }
        for task in self
            .tasks
            .values_mut()
            .filter(|t| t.snapshot.destination.library_id == id)
        {
            task.settle(true);
        }
        self.writers.remove(id);
        if self
            .current
            .as_ref()
            .is_some_and(|library| library.info().id == id)
        {
            self.current = None;
        }
        Ok(())
    }

    fn activate(&mut self, library: Library) -> Result<Arc<Library>, DeviceLibraryError> {
        self.device.register(library.info())?;
        let library = Arc::new(library);
        self.writers
            .retain(|_, library| Arc::strong_count(library) > 1);
        self.current = Some(library.clone());
        Ok(library)
    }

    /// 应用退出时结束全部导入；浏览切换不改变任务归属。
    fn finish_tasks(&mut self) {
        for task in self.tasks.values() {
            task.cancel();
        }
        for task in self.tasks.values_mut() {
            task.settle(true);
        }
        self.tasks.clear();
    }
}

impl Drop for DeviceLibraries {
    fn drop(&mut self) {
        self.finish_tasks();
    }
}
