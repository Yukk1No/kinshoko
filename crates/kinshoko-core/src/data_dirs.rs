//! 数据根目录（#145，ADR-0009）：程序自己的持久数据都在 `<exe 所在目录>\data\` 下。
//!
//! 设置、本设备的资料库登记、标签目录、工作区、钉图、截图历史、参考组、备份计划、打标模型、
//! 诊断与使用日志、WebView2 用户数据都从这里取路径；资料库（画师选的文件夹）不在此列。
//! 测试用的覆盖（`KINSHOKO_DATA_DIR`）把全部数据换到另一个目录，包括 `settings.json`。

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

/// exe 旁边数据根目录的名字。卸载钩子（`installer-hooks.nsh`）按这个名字询问是否删除。
pub const DIR_NAME: &str = "data";
const MODELS: &str = "models";
const LOGS: &str = "logs";
const WEBVIEW: &str = "webview";

/// 本进程的数据目录。启动时解析一次，各处都从这里取路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirs {
    root: PathBuf,
    device: PathBuf,
    settings: PathBuf,
    models: PathBuf,
    logs: PathBuf,
    webview: PathBuf,
}

impl DataDirs {
    /// `exe_dir` 下的 `data\`；给了覆盖目录时全部数据都在覆盖目录下。
    pub fn resolve(exe_dir: &Path, override_dir: Option<PathBuf>) -> DataDirs {
        DataDirs::under(override_dir.unwrap_or_else(|| exe_dir.join(DIR_NAME)))
    }

    /// 旧版本的位置。只在首次启动迁移失败时用：本次运行继续用旧数据，下次启动重试迁移。
    pub fn legacy(legacy: &LegacyDirs) -> DataDirs {
        DataDirs {
            root: legacy.roaming.clone(),
            device: legacy.roaming.clone(),
            settings: legacy.roaming.clone(),
            models: legacy.local.join(MODELS),
            logs: legacy.local.join(LOGS),
            webview: legacy.local.clone(),
        }
    }

    fn under(root: PathBuf) -> DataDirs {
        DataDirs {
            device: root.clone(),
            settings: root.clone(),
            models: root.join(MODELS),
            logs: root.join(LOGS),
            webview: root.join(WEBVIEW),
            root,
        }
    }

    /// 数据根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 本设备的数据：资料库登记、标签目录、工作区、钉图、截图历史、参考组与备份计划。
    pub fn device(&self) -> &Path {
        &self.device
    }

    /// 应用壳设置 `settings.json` 所在目录。
    pub fn settings(&self) -> &Path {
        &self.settings
    }

    /// 打标模型。
    pub fn models(&self) -> &Path {
        &self.models
    }

    /// 使用日志。
    pub fn logs(&self) -> &Path {
        &self.logs
    }

    /// WebView2 用户数据目录；本进程所有窗口都要用它，否则会建出多个互相冲突的 WebView2 环境。
    pub fn webview(&self) -> &Path {
        &self.webview
    }
}

/// 旧版本的两个数据目录：`%APPDATA%\dev.kinshoko` 与 `%LOCALAPPDATA%\dev.kinshoko`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDirs {
    pub roaming: PathBuf,
    pub local: PathBuf,
}

/// 首次启动迁移的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migration {
    /// 数据根目录已有数据，或旧位置没有数据。
    NotNeeded,
    /// 旧数据已全部搬进数据根目录。
    Migrated,
}

/// 旧目录里留下的说明。
const NOTE: &str = "MOVED.txt";
/// 迁移日志：暂存目录里每搬一项记一行“来源\t名字”。
/// 从另一个卷复制（而不是改名）的条目另记一行“copied\t名字”。
const JOURNAL: &str = ".migration-journal";
const COPIED: &str = "copied";
/// WebView2 在用户数据目录下建的子目录。
const EBWEBVIEW: &str = "EBWebView";

/// 数据根目录为空、旧位置有数据时，把旧数据搬进 `target`。
///
/// 同一个卷上逐项改名，模型再大也不复制；旧数据在另一个卷上时才复制，全部到齐后再删旧的。
/// 中途失败时已经搬过的条目改名回原处，旧位置保持原样，
/// 下次启动重试；数据根目录要么没有数据、要么是完整的一份。
pub fn migrate_legacy(target: &Path, legacy: &LegacyDirs) -> io::Result<Migration> {
    migrate_legacy_with(target, legacy, |from, to| fs::rename(from, to))
}

/// 同 [`migrate_legacy`]，改名由调用方提供。只给测试模拟中途失败用。
#[doc(hidden)]
pub fn migrate_legacy_with(
    target: &Path,
    legacy: &LegacyDirs,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<Migration> {
    if has_entries(target)? {
        // 上次在改名为数据根目录之后、删日志之前结束：数据已完整，日志没用了。
        let _ = fs::remove_file(target.join(JOURNAL));
        return Ok(Migration::NotNeeded);
    }
    let staging = staging_dir(target);
    // 上次迁移到一半进程就结束了：先把暂存的条目放回旧位置，再从头来过。
    if staging.exists() {
        restore(&staging, legacy)?;
    }
    let entries = plan(legacy)?;
    if entries.is_empty() {
        return Ok(Migration::NotNeeded);
    }
    fs::create_dir_all(&staging)?;
    let mut moved: Vec<Staged> = Vec::new();
    let staged = (|| {
        let mut journal = fs::File::create(staging.join(JOURNAL))?;
        for (origin, name) in entries {
            // 先记下来源再改名：改名之后进程随时可能结束，下次启动靠这一行放回原处。
            writeln!(journal, "{}\t{name}", origin.label())?;
            journal.sync_data()?;
            let (source, staged) = (origin.dir(legacy).join(&name), staging.join(&name));
            match rename(&source, &staged) {
                Ok(()) => moved.push(Staged::Moved { source, staged }),
                Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
                    // 先记下来，复制到一半失败或进程结束时也要删掉这份不完整的副本。
                    writeln!(journal, "{COPIED}\t{name}")?;
                    journal.sync_data()?;
                    moved.push(Staged::Copied {
                        source: source.clone(),
                        staged: staged.clone(),
                    });
                    copy_tree(&source, &staged)?;
                }
                Err(e) => return Err(e),
            }
        }
        drop(journal);
        if target.exists() {
            fs::remove_dir(target)?;
        }
        rename(&staging, target)
    })();
    if let Err(e) = staged {
        roll_back(&moved, &staging);
        return Err(e);
    }
    let _ = fs::remove_file(target.join(JOURNAL));
    for entry in &moved {
        if let Staged::Copied { source, .. } = entry {
            // 新位置已完整；旧副本删不掉只是多占空间。
            let _ = remove_tree(source);
        }
    }
    // WebView2 数据只是本地存储与缓存：能顺手改名就带上，不行也不影响迁移。
    let webview = target.join(WEBVIEW);
    if fs::create_dir_all(&webview).is_ok() {
        let _ = rename(&legacy.local.join(EBWEBVIEW), &webview.join(EBWEBVIEW));
    }
    let note = format!(
        "Kinshoko 的设置、打标模型等数据已移到：\r\n{}\r\n这个文件夹可以删除。\r\n",
        target.display()
    );
    for old in [&legacy.roaming, &legacy.local] {
        // 说明写不进去不影响数据：新位置已经完整。
        let _ = fs::write(old.join(NOTE), &note);
    }
    Ok(Migration::Migrated)
}

/// 暂存目录里的一项：改名搬来的，或从另一个卷复制来的（旧的还在原处）。
enum Staged {
    Moved { source: PathBuf, staged: PathBuf },
    Copied { source: PathBuf, staged: PathBuf },
}

/// 把这次已经搬进暂存目录的条目放回原处（复制来的直接删掉），再删掉暂存目录。
/// 放不回去的留在暂存目录，日志也留着，下次启动由 [`restore`] 再试。
fn roll_back(moved: &[Staged], staging: &Path) {
    for entry in moved.iter().rev() {
        let result = match entry {
            Staged::Moved { source, staged } => fs::rename(staged, source),
            Staged::Copied { staged, .. } => remove_tree(staged),
        };
        if let Err(e) = result {
            eprintln!("迁移回滚失败：{}：{e}", staging.display());
            return;
        }
    }
    let _ = fs::remove_file(staging.join(JOURNAL));
    let _ = fs::remove_dir(staging);
}

/// 按日志把上次中断时暂存的条目放回旧位置，删掉暂存目录。
fn restore(staging: &Path, legacy: &LegacyDirs) -> io::Result<()> {
    let journal = match fs::read_to_string(staging.join(JOURNAL)) {
        Ok(journal) => journal,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let lines: Vec<(&str, &str)> = journal.lines().filter_map(|l| l.split_once('\t')).collect();
    for &(origin, name) in &lines {
        let Some(origin) = Origin::from_label(origin) else {
            continue;
        };
        let staged = staging.join(name);
        if lines.contains(&(COPIED, name)) {
            // 从另一个卷复制来的副本（可能不完整），旧的还在原处。
            remove_tree(&staged)?;
        } else if staged.exists() {
            let source = origin.dir(legacy).join(name);
            if source.exists() {
                // 旧位置又有了同名条目（例如之后运行过旧版本）：两份都留着，不替画师选。
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("{} 与 {} 都存在", staged.display(), source.display()),
                ));
            }
            fs::create_dir_all(origin.dir(legacy))?;
            fs::rename(&staged, &source)?;
        }
    }
    let _ = fs::remove_file(staging.join(JOURNAL));
    // 日志之外还有东西（不该发生）就留着暂存目录、报错，不删画师的数据。
    fs::remove_dir(staging)
}

/// 复制一个文件或整个文件夹。
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(from)?.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// 删除一个文件或整个文件夹；本来就不在也算成功。
fn remove_tree(path: &Path) -> io::Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) => Err(e),
    };
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// 目录存在且不空。
fn has_entries(dir: &Path) -> io::Result<bool> {
    match fs::read_dir(dir) {
        Ok(mut listing) => Ok(listing.next().is_some()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// 迁移时先把旧数据搬进数据根目录旁边的暂存目录，全部到齐后一次改名为数据根目录。
fn staging_dir(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_owned();
    name.push(".migrating");
    target.with_file_name(name)
}

/// 旧条目来自哪个旧目录；日志里记它的标签，不记完整路径。
#[derive(Debug, Clone, Copy)]
enum Origin {
    Roaming,
    Local,
}

impl Origin {
    fn label(self) -> &'static str {
        match self {
            Origin::Roaming => "roaming",
            Origin::Local => "local",
        }
    }

    fn from_label(label: &str) -> Option<Origin> {
        [Origin::Roaming, Origin::Local]
            .into_iter()
            .find(|o| o.label() == label)
    }

    fn dir(self, legacy: &LegacyDirs) -> &Path {
        match self {
            Origin::Roaming => &legacy.roaming,
            Origin::Local => &legacy.local,
        }
    }
}

/// 要搬的旧条目。Roaming 在前；Local 里与之重名的条目留在原处。
/// 名字不是 UTF-8 或含制表符、换行的条目记不进日志，也留在原处。
fn plan(legacy: &LegacyDirs) -> io::Result<Vec<(Origin, String)>> {
    let mut entries: Vec<(Origin, String)> = Vec::new();
    for origin in [Origin::Roaming, Origin::Local] {
        let listing = match fs::read_dir(origin.dir(legacy)) {
            Ok(listing) => listing,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for entry in listing {
            let Ok(name) = entry?.file_name().into_string() else {
                continue;
            };
            if name == NOTE
                || name == EBWEBVIEW
                || name.contains(['\t', '\n', '\r'])
                || entries.iter().any(|(_, n)| *n == name)
            {
                continue;
            }
            entries.push((origin, name));
        }
    }
    Ok(entries)
}
