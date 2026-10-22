//! 应用壳的多资料库管理：登记表保存位置，同一时间只有一个活动资料库。

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use ts_rs::TS;

use crate::library::{
    ImportOptions, ImportProgress, ImportReport, ImportSource, ImportTask, SafeModeScope,
    SaveDestination,
};
use crate::{DeviceRegistry, Library, RegisteredLibrary};

mod imports;
mod writer_wait;
use imports::OwnedImport;
use writer_wait::FinishSignal;
pub use writer_wait::{
    ImportFinishWait, OrganizeWaiting, WriterAccess, WriterWaitError, wait_for_writer,
};

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

/// 当前进程的资料库与本设备登记。调用方将它放在互斥锁中，串行处理切换。
pub struct DeviceLibraries {
    pub(crate) import_preview: Option<Arc<crate::workspace::ImportPreviewAuthorization>>,
    device: DeviceRegistry,
    current: Option<Arc<Library>>,
    tasks: HashMap<String, OwnedImport>,
    /// Writable providers are reused without changing current or last-opened state.
    writers: HashMap<String, Arc<Library>>,
    finished: Arc<FinishSignal>,
    /// 本设备的安全模式范围（#223）：设给每个开着的句柄和之后打开的句柄。
    safe_mode_scope: SafeModeScope,
}

impl DeviceLibraries {
    /// 读取登记表；恢复上次打开的库由调用方显式触发，以便展示不可用原因。
    pub fn open(dir: &Path) -> Result<Self, DeviceLibraryError> {
        Ok(Self {
            device: DeviceRegistry::open(dir)?,
            import_preview: None,
            current: None,
            tasks: HashMap::new(),
            writers: HashMap::new(),
            finished: Arc::default(),
            safe_mode_scope: SafeModeScope::default(),
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

    /// 在资源管理器中打开图库（#114）：登记的位置，且那里仍是这个图库。移动盘拔出、搬家或
    /// 换成了别的库时报原因（与登记检查相同的文案）。只读检查，调用方先放开登记表的锁。
    pub fn library_folder(
        libraries: &[RegisteredLibrary],
        library_id: &str,
    ) -> Result<PathBuf, DeviceLibraryError> {
        let registration = libraries
            .iter()
            .find(|entry| entry.id == library_id)
            .ok_or(DeviceLibraryError::UnknownLibrary)?;
        Self::inspect(&registration.root, Some(library_id))?;
        Ok(registration.root.clone())
    }

    pub fn current(&self) -> Option<Arc<Library>> {
        self.current.clone()
    }

    /// 建立、登记并切换到新资料库。
    pub fn create(&mut self, root: &Path, name: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        self.close_import_preview(None);
        let library = Library::create(root, name).map_err(DeviceLibraryError::Library)?;
        self.activate(library)
    }

    /// 请求必须带上界面正在操作的资料库身份，旧请求不能取得新资料库。
    pub fn require(&self, library_id: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        self.current()
            .filter(|library| library.info().id == library_id)
            .ok_or(DeviceLibraryError::StaleLibrary)
    }

    /// 界面读某个库（浏览、详情、目录、词表……，ADR-0008）：不要求它持有可写句柄，也不切换。
    /// 它就是可写库或仍被导入持有时沿用那个句柄（安全模式随设置，见 [`Self::set_safe_mode`]）；
    /// 否则只读打开、核对身份，并设成调用方的安全模式 `safe`。
    pub fn resolve(
        &self,
        library_id: &str,
        safe: bool,
    ) -> Result<Arc<Library>, DeviceLibraryError> {
        if !self.libraries().iter().any(|entry| entry.id == library_id) {
            return Err(DeviceLibraryError::UnknownLibrary);
        }
        if let Some(library) = self
            .current
            .as_ref()
            .filter(|library| library.info().id == library_id)
            .or_else(|| self.writers.get(library_id))
        {
            return Ok(library.clone());
        }
        let library = self.read(library_id)?;
        library.set_safe_mode(safe);
        Ok(library)
    }

    /// 安全模式设置变了：设给每个开着的可写句柄（可写库，以及导入仍持有的库），
    /// 后端切换可写句柄后它们不会留着旧视角。
    pub fn set_safe_mode(&self, on: bool) {
        for library in self.current.iter().chain(self.writers.values()) {
            library.set_safe_mode(on);
        }
    }

    /// 本设备的安全模式范围（#223）。
    pub fn safe_mode_scope(&self) -> SafeModeScope {
        self.safe_mode_scope
    }

    /// 安全模式范围设置变了：与 [`Self::set_safe_mode`] 一样设给每个开着的可写句柄（它们的
    /// 修订号前进并推送列表与词表变化），之后打开的句柄也按它打开。工作区快照按范围区分。
    /// 每个句柄都先换上新范围；有句柄写修订号失败时返回第一个错误。
    pub fn set_safe_mode_scope(&mut self, scope: SafeModeScope) -> Result<(), DeviceLibraryError> {
        self.safe_mode_scope = scope;
        let mut first = Ok(());
        for library in self.current.iter().chain(self.writers.values()) {
            if let Err(error) = library.set_safe_mode_scope(scope)
                && first.is_ok()
            {
                first = Err(DeviceLibraryError::Library(error));
            }
        }
        first
    }

    /// 新打开的句柄按本设备的范围设好（不推送变化：它还没有旧的结果）。
    fn scoped(&self, library: Library) -> Library {
        library.init_safe_mode_scope(self.safe_mode_scope);
        library
    }

    /// Resolve a registered content provider without switching the active library or
    /// changing last-opened state. Every reader is isolated, read-only and identity-checked.
    pub fn read(&self, library_id: &str) -> Result<Arc<Library>, DeviceLibraryError> {
        let registration = self
            .libraries()
            .iter()
            .find(|entry| entry.id == library_id)
            .ok_or(DeviceLibraryError::UnknownLibrary)?;
        let library = Self::read_registered(registration)?;
        library.init_safe_mode_scope(self.safe_mode_scope);
        Ok(library)
    }

    /// 按一条登记只读打开资料库：与 [`Self::read`] 相同的身份核对，但不需要登记表本身，
    /// 调用方可以在登记表的锁外先打开（#123 的缩略图请求）。
    pub fn read_registered(
        registration: &RegisteredLibrary,
    ) -> Result<Arc<Library>, DeviceLibraryError> {
        let library_id = registration.id.as_str();
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
        let library = self.scoped(library);
        if library.info().id != library_id {
            return Err(DeviceLibraryError::IdentityChanged {
                root: registration.root,
            });
        }
        let library = Arc::new(library);
        self.writers.insert(library_id.into(), library.clone());
        Ok(library)
    }

    /// 画师整理这个库（ADR-0008）：后端只为一个库持有可写句柄，按需切过去。目标库或当前持有者
    /// 有导入在收尾时不切换、不执行，返回等待；不改画师“上次打开”的库。
    pub fn organize(&mut self, library_id: &str) -> Result<WriterAccess, DeviceLibraryError> {
        let registration = self
            .libraries()
            .iter()
            .find(|entry| entry.id == library_id)
            .cloned()
            .ok_or(DeviceLibraryError::UnknownLibrary)?;
        let holder = self
            .current
            .as_ref()
            .map(|library| library.info().id.clone());
        let seen = self.finished.current();
        for task in self.tasks.values_mut() {
            task.settle(false);
        }
        let mut finishing: Vec<String> = Vec::new();
        let mut ids = vec![library_id];
        ids.extend(holder.as_deref().filter(|holder| *holder != library_id));
        for id in ids {
            if let Some(task) = self
                .tasks
                .values()
                .find(|task| task.snapshot.destination.library_id == id && task.is_finishing())
            {
                finishing.push(task.snapshot.library_name.clone());
            }
        }
        if !finishing.is_empty() {
            return Ok(WriterAccess::Waiting(ImportFinishWait {
                notice: OrganizeWaiting {
                    library_id: library_id.into(),
                    finishing,
                },
                signal: self.finished.clone(),
                seen,
            }));
        }
        if holder.as_deref() == Some(library_id) {
            let library = self.current().expect("当前持有者");
            Self::inspect(&registration.root, Some(library_id))?;
            return Ok(WriterAccess::Ready {
                library,
                switched: false,
            });
        }
        let library = self.write(library_id)?;
        self.current = Some(library.clone());
        self.writers
            .retain(|_, library| Arc::strong_count(library) > 1);
        Ok(WriterAccess::Ready {
            library,
            switched: true,
        })
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
        self.close_import_preview(None);
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
        self.close_import_preview(None);
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
        self.close_import_preview(None);
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
        self.finished.advance();
        Ok(())
    }

    fn activate(&mut self, library: Library) -> Result<Arc<Library>, DeviceLibraryError> {
        self.device.register(library.info())?;
        let library = Arc::new(self.scoped(library));
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
