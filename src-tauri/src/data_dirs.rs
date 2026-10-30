//! 数据根目录（#145，ADR-0009）：在建 Tauri 应用之前解析一次，交给各插件与窗口。
//!
//! 规则与迁移在 `kinshoko_core::data_dirs`；这里只找 exe 所在目录与旧版本的两个目录、
//! 检查能不能写、在首次启动时迁移。其他模块一律从 [`app_data`] 取路径，不再自己调用
//! `app_data_dir`／`app_config_dir`／`app_local_data_dir`（`kinshoko-core` 的
//! `tests/data_dirs.rs` 检查源码锁住这一点：CI 只跑核心 crate 的测试）。

use crate::ui_text;
use std::path::{Path, PathBuf};

use kinshoko_core::data_dirs::{DataDirs, LegacyDirs, Migration, migrate_legacy};
use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};

/// 测试用的覆盖：设置后全部数据（包括 `settings.json`）都在这个目录，不迁移旧数据。
/// WebDriver 冒烟测试用它隔离数据。
const DATA_DIR_ENV: &str = "KINSHOKO_DATA_DIR";
/// 旧版本按 Tauri `identifier` 在 `%APPDATA%` 与 `%LOCALAPPDATA%` 下建的目录名。
const LEGACY_DIR_NAME: &str = "dev.kinshoko";

/// 本进程的数据目录，以及首次启动迁移失败的原因（有的话本次运行用旧位置）。
pub struct AppData {
    pub dirs: DataDirs,
    pub migration_problem: Option<String>,
    /// 进程在世期间一直持有：第二次启动（随后交给单实例插件退出）不会同时迁移。
    _instance: Option<std::fs::File>,
}

/// 解析数据根目录、确认可写，需要时把旧数据迁过来。数据根目录不可写时返回给画师看的说明，
/// 不换到别处；迁移失败时本次运行用旧位置、下次启动重试（ADR-0009）。
pub fn prepare() -> Result<AppData, String> {
    let exe = std::env::current_exe().map_err(|e| ui_text::exe_not_found(&e))?;
    let exe_dir = exe.parent().unwrap_or(Path::new("."));
    let override_dir = std::env::var_os(DATA_DIR_ENV).map(PathBuf::from);
    // 开发构建（target\debug）不迁移：免得把本机正式安装的数据搬进开发目录。
    let migrate = override_dir.is_none() && !cfg!(debug_assertions);
    let dirs = DataDirs::resolve(exe_dir, override_dir);
    std::fs::create_dir_all(dirs.root())
        .and_then(|()| probe_writable(dirs.root()))
        .map_err(|e| unwritable(dirs.root(), &e))?;
    // 数据根目录旁边的锁文件：已有实例在跑时它可能正用着旧位置，这次启动不迁移。
    let instance = std::fs::File::create(lock_path(dirs.root()))
        .ok()
        .filter(|lock| lock.try_lock().is_ok());
    let mut data = AppData {
        dirs,
        migration_problem: None,
        _instance: None,
    };
    if !migrate || instance.is_none() {
        return Ok(data);
    }
    data._instance = instance;
    let Some(legacy) = legacy_dirs() else {
        return Ok(data);
    };
    match migrate_legacy(data.dirs.root(), &legacy) {
        Ok(Migration::Migrated | Migration::NotNeeded) => {}
        Err(e) if e.legacy_intact => {
            eprintln!(
                "把旧数据迁到 {} 失败，本次继续用旧位置：{e}",
                data.dirs.root().display()
            );
            data.dirs = DataDirs::legacy(&legacy);
            data.migration_problem = Some(e.to_string());
        }
        // 旧位置缺了东西：回到旧位置运行会在那里新建空的设置与登记表，停下来说明。
        Err(e) => {
            return Err(ui_text::migration_failed(&e));
        }
    }
    Ok(data)
}

/// 本进程的数据目录。
pub fn app_data<R: Runtime>(app: &AppHandle<R>) -> &DataDirs {
    &app.state::<AppData>().inner().dirs
}

/// 首次启动迁移失败的原因（诊断信息用）。
pub fn migration_problem<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.state::<AppData>().migration_problem.clone()
}

/// 实例锁：`data` 旁边的 `data.lock`（不放进 `data` 里，空的数据根目录才会迁移）。
/// 卸载钩子会删掉它。
fn lock_path(root: &Path) -> PathBuf {
    let mut name = root.file_name().unwrap_or_default().to_owned();
    name.push(".lock");
    root.with_file_name(name)
}

/// 本进程每个窗口都要套上：同一个 WebView2 环境要求用户数据目录与启动参数一致，
/// 否则后建的窗口会因为环境冲突建不出来。
pub trait SharedWebview<R: Runtime> {
    fn shared_webview(self, app: &AppHandle<R>) -> Self;
}

impl<R: Runtime, M: Manager<R>> SharedWebview<R> for WebviewWindowBuilder<'_, R, M> {
    fn shared_webview(self, app: &AppHandle<R>) -> Self {
        self.data_directory(app_data(app).webview().to_path_buf())
            .additional_browser_args(crate::diagnostics::browser_args())
    }
}

/// 启动失败时给画师看的说明。数据根目录不可写时不悄悄换到别处（ADR-0009）。
fn unwritable(root: &Path, error: &std::io::Error) -> String {
    ui_text::data_unwritable(root, error)
}

/// 在数据根目录里建一个关闭即删的文件，确认能写。不留下任何东西，免得空目录被当成“已有数据”。
fn probe_writable(root: &Path) -> std::io::Result<()> {
    let probe = root.join(".kinshoko-write-test");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        // GENERIC_WRITE | DELETE 与 FILE_FLAG_DELETE_ON_CLOSE：句柄关闭时系统删除文件。
        options.access_mode(0x4000_0000 | 0x0001_0000);
        options.custom_flags(0x0400_0000);
    }
    drop(options.open(&probe)?);
    if cfg!(windows) {
        Ok(())
    } else {
        std::fs::remove_file(&probe)
    }
}

/// 旧版本的两个数据目录：Tauri 的 `app_data_dir`／`app_config_dir`（Roaming）与
/// `app_local_data_dir`（Local）。这时 Tauri 应用还没建，按同样的规则从环境变量取。
fn legacy_dirs() -> Option<LegacyDirs> {
    if !cfg!(windows) {
        return None;
    }
    let roaming = std::env::var_os("APPDATA")?;
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(LegacyDirs {
        roaming: PathBuf::from(roaming).join(LEGACY_DIR_NAME),
        local: PathBuf::from(local).join(LEGACY_DIR_NAME),
    })
}
