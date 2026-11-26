//! 工作区会话（#749）：本设备上跨资料库操作的全部共享状态，以及取这些状态的固定顺序。
//!
//! [`WorkspaceSession`] 拥有登记表与资料库（[`DeviceLibraries`]）、统一标签目录与查找
//! （[`CatalogSearch`]）、工作区（[`Workspace`]）、缩略图放行（[`ImageGate`]）、安全模式
//! （[`SafeModeState`]）与导入预览的授权代次。应用壳只持有一个会话，按命令转发。
//!
//! 取锁顺序固定为：切换（[`WorkspaceSession::transition`]）→ 可见性许可
//! （[`VisibilityPermit`]）→ 资源（登记表 → 统一标签目录 → 工作区）。持锁期间不能 await、
//! 不能重入；持许可或资源时不能再等切换，持资源时不能再等许可。开发构建里违反顺序立即 panic，
//! 不会静默死锁。
//!
//! 安全模式只能经 [`VisibilityPermit`] 改动：提交与最后的对外动作（发送、复制、钉图）互斥。
//! “锁外准备 → 进门复核 → 门内生效”由 [`VisibilityPermit::commit`] 与
//! [`VisibilityPermit::stream`] 完成，调用方不接触裸锁、不手工复核代次。

mod order;
mod permit;

pub use permit::{Grant, VisibilityPermit};

use std::panic::Location;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::diagnostics::HeldLock;
use crate::library::{Error, SafeMode};
use crate::safe_mode::{LensStale, SafeModeState};
use crate::search::CatalogSearch;
use crate::tag_catalog::{CatalogError, TagCatalog};
use crate::workspace::{ImageGate, Workspace};
use crate::{CommandError, DeviceLibraries, DeviceLibraryError, Library};

/// 取资源时要哪一级保证（[`WorkspaceSession::with_lens`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// 只核对开关：界面的开关与设置不一致时不取资源。
    Read,
    /// 做完再复核代次：其间安全模式变过就丢弃结果。
    Confirmed,
    /// 再加上前后修订号不变，变了得到游标过期。
    Stable,
    /// 先取切换与可见性许可，再做 Confirmed 的事：与安全模式提交、后台分级发布互斥。
    Commit,
}

/// 本设备的工作区会话，见模块说明。
pub struct WorkspaceSession {
    device_dir: PathBuf,
    /// 切换、恢复和取消登记串行完成，包括旧库打标退出。
    transition: Mutex<()>,
    /// 可见性许可的门：安全模式提交、来源与分级发布、最后的对外动作在它里面串行。
    visibility: Arc<Mutex<()>>,
    safe_mode: SafeModeState,
    /// 本设备登记表与活动资料库；第一次用到时读取登记表。
    libraries: Mutex<Option<DeviceLibraries>>,
    /// 统一标签目录与其上的查找（#76、#272），目录锁在它里面。
    search: Arc<CatalogSearch>,
    workspace: Mutex<Option<Workspace>>,
    /// 缩略图请求的放行（#313）：工作区每次取快照发布到这里，缩略图请求先问它，不拿上面的锁。
    gate: Arc<ImageGate>,
    /// 导入预览的授权代次：每次作废都前进，进行中的预览读取在下一块前停下。
    import_preview: AtomicU64,
}

/// 持有切换锁，见 [`WorkspaceSession::transition`]。
pub struct Transition<'a> {
    _guard: MutexGuard<'a, ()>,
    _order: order::Held,
}

/// 登记表的锁，等锁、持锁久了记进运行日志（#337）。
pub struct LibrariesGuard<'a> {
    guard: MutexGuard<'a, Option<DeviceLibraries>>,
    _held: HeldLock,
    _order: order::Held,
}

impl std::ops::Deref for LibrariesGuard<'_> {
    type Target = Option<DeviceLibraries>;
    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl std::ops::DerefMut for LibrariesGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl WorkspaceSession {
    /// `device_dir` 是本设备数据目录（登记表、工作区与统一标签目录都在这里）；`safe_mode` 是设置
    /// 里的安全模式；`search` 是统一标签目录上的查找。
    pub fn new(device_dir: PathBuf, safe_mode: SafeMode, search: CatalogSearch) -> Self {
        Self {
            device_dir,
            transition: Mutex::default(),
            visibility: Arc::default(),
            safe_mode: SafeModeState::new(safe_mode),
            libraries: Mutex::default(),
            search: Arc::new(search),
            workspace: Mutex::default(),
            gate: Arc::default(),
            import_preview: AtomicU64::new(0),
        }
    }

    pub fn device_dir(&self) -> &Path {
        &self.device_dir
    }

    /// 本设备安全模式的权威状态，只读：改动经 [`VisibilityPermit`]。
    pub fn safe_mode(&self) -> &SafeModeState {
        &self.safe_mode
    }

    pub fn search(&self) -> &Arc<CatalogSearch> {
        &self.search
    }

    pub fn gate(&self) -> &Arc<ImageGate> {
        &self.gate
    }

    /// 取切换锁。必须在许可与资源之前取。
    pub fn transition(&self) -> Transition<'_> {
        let order = order::Held::transition();
        Transition {
            _guard: lock(&self.transition),
            _order: order,
        }
    }

    /// 进可见性许可的门。不能在持资源或另一个许可时调用。
    pub fn visibility(&self) -> VisibilityPermit<'_> {
        VisibilityPermit::enter(self)
    }

    /// 在可见性许可里调用 `f`，见 [`VisibilityPermit`]。
    pub fn with_visibility<T>(&self, f: impl FnOnce(&VisibilityPermit<'_>) -> T) -> T {
        f(&self.visibility())
    }

    /// 资料库装配时调用：导入、包与复制的分级发布与可见性许可用同一个门。
    pub fn configure_library(&self, library: &Library) {
        library.use_package_publication_gate(self.visibility.clone());
    }

    /// 后台打标发布分级时用的门，与可见性许可是同一个。只给打标调度器的配置用：发布在调度器的
    /// 工作线程上，停下或等它退出之前要放开。
    pub fn tagging_publication_gate(&self) -> Arc<Mutex<()>> {
        self.visibility.clone()
    }

    /// 登记表的锁，等锁、持锁久了按调用处记进运行日志。
    #[track_caller]
    pub fn lock_libraries(&self) -> LibrariesGuard<'_> {
        self.lock_libraries_at(Location::caller())
    }

    pub fn lock_libraries_at(&self, site: &'static Location<'static>) -> LibrariesGuard<'_> {
        let order = order::Held::resources();
        let waiting = std::time::Instant::now();
        let guard = lock(&self.libraries);
        LibrariesGuard {
            guard,
            _held: HeldLock::acquired("登记表", site, waiting),
            _order: order,
        }
    }

    /// 登记表正被别处持有时不等，得到 `None`；登记表还没读时 `f` 收到 `None`。只为记日志一类的事。
    pub fn try_with_libraries<T>(
        &self,
        f: impl FnOnce(Option<&DeviceLibraries>) -> T,
    ) -> Option<T> {
        let guard = self.libraries.try_lock().ok()?;
        Some(f(guard.as_ref()))
    }

    /// 持登记表的锁调用 `action`；登记表第一次用到时打开，按设置里的安全模式范围设好。
    #[track_caller]
    pub fn with_libraries<T>(
        &self,
        action: impl FnOnce(&mut DeviceLibraries) -> Result<T, DeviceLibraryError>,
    ) -> Result<T, CommandError> {
        self.with_libraries_at(Location::caller(), action)
    }

    pub fn with_libraries_at<T>(
        &self,
        site: &'static Location<'static>,
        action: impl FnOnce(&mut DeviceLibraries) -> Result<T, DeviceLibraryError>,
    ) -> Result<T, CommandError> {
        let mut libraries = self.lock_libraries_at(site);
        let device = self.opened(&mut libraries).map_err(CommandError::from)?;
        action(device).map_err(CommandError::from)
    }

    fn opened<'g>(
        &self,
        libraries: &'g mut LibrariesGuard<'_>,
    ) -> Result<&'g mut DeviceLibraries, DeviceLibraryError> {
        if libraries.is_none() {
            let mut opened = DeviceLibraries::open(&self.device_dir)?;
            // 刚打开，还没有句柄：只记下范围，不会失败。
            opened.set_safe_mode_scope(self.safe_mode.current().scope)?;
            **libraries = Some(opened);
        }
        Ok(libraries.as_mut().expect("登记表已打开"))
    }

    /// 依次取登记表、统一标签目录与工作区，在锁里调用 `f`。调用方自己负责视角与许可。
    #[track_caller]
    pub fn with_resources<T>(
        &self,
        f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
    ) -> Result<T, CommandError> {
        self.with_resources_at(Location::caller(), f)
    }

    pub fn with_resources_at<T>(
        &self,
        site: &'static Location<'static>,
        f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
    ) -> Result<T, CommandError> {
        // 三把锁都记在调用方的位置上（#337）：日志里看得出是哪个命令占着它们。
        let mut libraries = self.lock_libraries_at(site);
        let device = self.opened(&mut libraries).map_err(CommandError::from)?;
        self.search
            .with_catalog_at(site, |catalog| {
                let waiting = std::time::Instant::now();
                let mut slot = lock(&self.workspace);
                let _held = HeldLock::acquired("工作区", site, waiting);
                if slot.is_none() {
                    *slot = Some(Workspace::open_with_gate(
                        &self.device_dir,
                        self.gate.clone(),
                    )?);
                }
                f(slot.as_mut().expect("工作区已打开"), device, catalog)
            })
            .map_err(CommandError::from)
    }

    /// 关掉工作区，下次用到时重新打开（例如设置整份替换后）。
    pub fn reset_workspace(&self) {
        let _order = order::Held::resources();
        *lock(&self.workspace) = None;
    }

    /// 按 `hold` 取资源锁并核对安全模式，在锁里调用 `f`。开关 `safe` 与设置不一致、或按 `hold`
    /// 复核时安全模式变过，得到 [`Error::LensChanged`]。
    #[track_caller]
    pub fn with_lens<T>(
        &self,
        safe: bool,
        hold: Hold,
        f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
    ) -> Result<T, CommandError> {
        self.with_lens_at(safe, hold, Location::caller(), f)
    }

    pub fn with_lens_at<T>(
        &self,
        safe: bool,
        hold: Hold,
        site: &'static Location<'static>,
        f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
    ) -> Result<T, CommandError> {
        match hold {
            Hold::Read => {
                self.safe_mode.lens_expecting(safe)?;
                self.with_resources_at(site, f)
            }
            Hold::Confirmed => self.confirmed(safe, site, f),
            Hold::Stable => self.confirmed(safe, site, |workspace, device, catalog| {
                let before = workspace.status(device, catalog, safe)?;
                let value = f(workspace, device, catalog)?;
                let after = workspace.status(device, catalog, safe)?;
                if before.revision != after.revision {
                    return Err(Error::CursorExpired.into());
                }
                Ok(value)
            }),
            Hold::Commit => {
                let _transition = self.transition();
                // 包括来源编辑器的分级与永久删除来源。
                let _visibility = self.visibility();
                self.confirmed(safe, site, f)
            }
        }
    }

    fn confirmed<T>(
        &self,
        safe: bool,
        site: &'static Location<'static>,
        f: impl FnOnce(&mut Workspace, &mut DeviceLibraries, &mut TagCatalog) -> Result<T, CatalogError>,
    ) -> Result<T, CommandError> {
        let lens = self.safe_mode.lens_expecting(safe)?;
        let value = self.with_resources_at(site, f)?;
        lens.confirm(&self.safe_mode)?;
        Ok(value)
    }

    /// 读任何一个已登记资料库里的这张图，不切换活动资料库。没登记、按设置里的安全模式被隐藏
    /// （任一份相同字节的副本在范围内即算）、读的途中安全模式或修订号变过，都得到错误。
    #[track_caller]
    pub fn visible_source(
        &self,
        library_id: &str,
        image_id: &str,
    ) -> Result<Arc<Library>, CommandError> {
        let safe = self.safe_mode.current().on;
        self.with_lens_at(
            safe,
            Hold::Stable,
            Location::caller(),
            |workspace, device, catalog| {
                if !workspace.contains(device, catalog, library_id, image_id, safe)? {
                    return Err(Error::UnknownImage.into());
                }
                let library = device
                    .read(library_id)
                    .map_err(|e| CatalogError::Command(Box::new(e.into())))?;
                library.set_safe_mode(safe);
                Ok(library)
            },
        )
    }

    /// 按设置里的开关记下这次操作的授权。
    pub fn grant(&self) -> Grant {
        Grant::new(self.safe_mode.lens(), None)
    }

    /// 同 [`Self::grant`]，界面传来的开关 `on` 与设置不一致时直接失败。
    pub fn grant_expecting(&self, on: bool) -> Result<Grant, LensStale> {
        Ok(Grant::new(self.safe_mode.lens_expecting(on)?, None))
    }

    /// 导入预览读取的授权：只在安全模式开启时有效，并绑定此刻的导入预览代次。
    pub fn import_preview_grant(&self) -> Result<Grant, LensStale> {
        Ok(Grant::new(
            self.safe_mode.lens_expecting(true)?,
            Some(self.import_preview.load(Ordering::SeqCst)),
        ))
    }

    /// 不进许可就作废进行中的导入预览：只让代次前进，正在发送的预览在下一块前停下。给不能等
    /// 许可的线程用（例如窗口线程），之后仍要在许可里 [`VisibilityPermit::revoke_import_preview`]。
    pub fn fence_import_preview(&self) {
        self.import_preview.fetch_add(1, Ordering::SeqCst);
    }

    /// 放掉缩略图放行长期只读打开的资料库（Windows 上握着句柄时文件夹改不了名、删不掉）。
    pub fn release_readers(&self) {
        self.gate.clear();
    }
}
