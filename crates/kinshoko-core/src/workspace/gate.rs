//! 缩略图请求的放行（#313）：不拿登记表、标签目录与工作区这三把全局锁，也不重开资料库。
//!
//! 工作区每次取快照都把它发布到这里；每个登记的资料库保留一个长期打开的只读句柄，快照与放行
//! 共用。放行只回答“这张图现在能不能给”：发布的快照仍对应当前的登记表、安全模式范围，且每个
//! 资料库的修订号与快照取到的相同，才按快照里的身份与封印判断；任何一项对不上都交还调用方走
//! 慢路（拿锁、重取快照，快照随之重新发布）。被封印的图绝不能从这里给出。
//!
//! 这些句柄多处共用，始终是不按安全模式过滤的视角（与快照取清单时一样），谁也不改它的开关：
//! 封印由快照按全部来源判断，比单个库自己的判断更严。
use super::*;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct ImageGate {
    published: Mutex<Option<Published>>,
    readers: Mutex<BTreeMap<String, Held>>,
}

struct Published {
    snapshot: Arc<Snapshot>,
    /// 登记表的改动计数，和取快照时它的值。
    registry: (Arc<std::sync::atomic::AtomicU64>, u64),
}

/// 一个登记的资料库长期打开的只读句柄，和打开时数据库文件的标识。
struct Held {
    root: PathBuf,
    stamp: Option<FileStamp>,
    library: Arc<crate::library::Library>,
}

/// 数据库文件的标识：文件被换掉（恢复备份、整个文件夹换成另一个库）就不同，句柄要重开。
/// Windows 上 SQLite 打开的文件不允许删除或改名，握着句柄时换不掉，创建时间足以区分重开前后；
/// 其他系统按设备号与 inode。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp(u64, u64);

fn stamp(root: &std::path::Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(root.join(crate::library::DB_FILE)).ok()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Some(FileStamp(meta.creation_time(), 0))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileStamp(meta.dev(), meta.ino()))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = meta;
        None
    }
}

impl ImageGate {
    /// 放掉所有句柄与发布的快照：切换、登记变化、设置整份替换时，释放数据库文件。
    pub fn clear(&self) {
        *lock(&self.published) = None;
        lock(&self.readers).clear();
    }

    pub(super) fn publish(
        &self,
        snapshot: Arc<Snapshot>,
        registry: (Arc<std::sync::atomic::AtomicU64>, u64),
    ) {
        *lock(&self.published) = Some(Published { snapshot, registry });
    }

    /// 这条登记的长期只读句柄；没有、位置变了或数据库文件换了时重新打开（身份核对同
    /// [`DeviceLibraries::read_registered`]）。打开不在表的锁里做。
    pub(super) fn reader(
        &self,
        registration: &crate::RegisteredLibrary,
        scope: crate::library::SafeModeScope,
    ) -> Result<Arc<crate::library::Library>, String> {
        let now = stamp(&registration.root);
        if let Some(held) = lock(&self.readers).get(&registration.id)
            && held.root == registration.root
            && now.is_some()
            && held.stamp == now
        {
            held.library.init_safe_mode_scope(scope);
            return Ok(held.library.clone());
        }
        let library = DeviceLibraries::read_registered(registration).map_err(|e| {
            lock(&self.readers).remove(&registration.id);
            e.to_string()
        })?;
        library.init_safe_mode_scope(scope);
        library.set_safe_mode(false);
        lock(&self.readers).insert(
            registration.id.clone(),
            Held {
                root: registration.root.clone(),
                stamp: now,
                library: library.clone(),
            },
        );
        Ok(library)
    }

    /// 已经握着、身份没变的句柄；不打开新的。
    fn held(
        &self,
        registration: &crate::RegisteredLibrary,
    ) -> Option<Arc<crate::library::Library>> {
        let readers = lock(&self.readers);
        let held = readers.get(&registration.id)?;
        (held.root == registration.root
            && held.stamp.is_some()
            && held.stamp == stamp(&registration.root))
        .then(|| held.library.clone())
    }

    /// 按发布的快照放行一张图。`None`：发布的快照不能代表现在（没有发布、登记表或安全模式范围
    /// 变了、某个资料库的修订号变了或句柄不在手里），调用方走慢路。`Some(Err)`：这张图不存在
    /// 或被封印。`scope` 取设置里当前的安全模式范围；调用方另外按安全模式代次复核。
    pub fn authorize(
        &self,
        library_id: &str,
        image_id: &str,
        safe: bool,
        scope: crate::library::SafeModeScope,
    ) -> Option<Result<Arc<crate::library::Library>, Error>> {
        let (snapshot, registry) = {
            let published = lock(&self.published);
            let published = published.as_ref()?;
            (published.snapshot.clone(), published.registry.clone())
        };
        if registry.0.load(std::sync::atomic::Ordering::SeqCst) != registry.1
            || snapshot.scope != scope
        {
            return None;
        }
        let mut shown = None;
        for provider in &snapshot.providers {
            let registration = &provider.registration.library;
            if provider.registration.unavailable.is_some() {
                // 快照里离线的库按记下的事实否决；它接回来了，事实可能已变，交给慢路重取。
                if registration.root.join(crate::library::DB_FILE).exists() {
                    return None;
                }
                continue;
            }
            let library = self.held(registration)?;
            if library.provider_revision().ok()? != (provider.list, provider.revision) {
                return None;
            }
            if registration.id == library_id {
                shown = Some(library);
            }
        }
        let allowed = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
            .is_some_and(|hash| !safe || !snapshot.adult.contains(hash));
        let Some(library) = shown.filter(|_| allowed) else {
            return Some(Err(Error::UnknownImage));
        };
        library.init_safe_mode_scope(scope);
        Some(Ok(library))
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
