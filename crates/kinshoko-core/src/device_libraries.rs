//! 应用壳的多资料库管理：登记表保存位置，同一时间只有一个活动资料库。

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;

use crate::library::{ImportOptions, ImportSource, ImportTask};
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

/// 当前进程的资料库与本设备登记。调用方将它放在互斥锁中，串行处理切换。
pub struct DeviceLibraries {
    device: DeviceRegistry,
    current: Option<Arc<Library>>,
    tasks: HashMap<String, ImportTask>,
}

impl DeviceLibraries {
    /// 读取登记表；恢复上次打开的库由调用方显式触发，以便展示不可用原因。
    pub fn open(dir: &Path) -> Result<Self, DeviceLibraryError> {
        Ok(Self {
            device: DeviceRegistry::open(dir)?,
            current: None,
            tasks: HashMap::new(),
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
        let library = self.require(library_id)?;
        self.tasks.retain(|_, task| !task.is_finished());
        let task = library.import_with_options(source, options);
        let id = task.id().to_owned();
        self.tasks.insert(id.clone(), task);
        Ok(id)
    }

    pub fn cancel_import(&self, library_id: &str, task_id: &str) -> Result<(), DeviceLibraryError> {
        self.require(library_id)?;
        if let Some(task) = self.tasks.get(task_id) {
            task.cancel();
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
        if self
            .current
            .as_ref()
            .is_some_and(|library| library.info().id == id)
        {
            self.finish_tasks();
            self.current = None;
        }
        Ok(())
    }

    fn activate(&mut self, library: Library) -> Result<Arc<Library>, DeviceLibraryError> {
        self.device.register(library.info())?;
        self.finish_tasks();
        let library = Arc::new(library);
        self.current = Some(library.clone());
        Ok(library)
    }

    /// 切换返回前结束全部旧库导入：正在处理的一项提交后停止，已成功的项保留。
    fn finish_tasks(&mut self) {
        for task in self.tasks.values() {
            task.cancel();
        }
        for (_, task) in self.tasks.drain() {
            task.wait();
        }
    }
}

impl Drop for DeviceLibraries {
    fn drop(&mut self) {
        self.finish_tasks();
    }
}
