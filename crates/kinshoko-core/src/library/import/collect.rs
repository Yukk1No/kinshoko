//! 导入的第一步：把所选的文件与文件夹展开成要逐项准备的文件。
use super::*;

/// 与 collect 相同的 Eagle 识别边界，预检只读取目录，不提前登记或刷新来源。
pub(in crate::library) fn contains_eagle(source: &ImportSource) -> bool {
    fn contains(path: &Path, ancestry: &mut Vec<PathBuf>) -> bool {
        if eagle::is_library(path) || eagle::is_item(path) {
            return true;
        }
        if !path.is_dir() || !enter(path, ancestry) {
            return false;
        }
        let found = std::fs::read_dir(path).is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| contains(&entry.path(), ancestry))
        });
        ancestry.pop();
        found
    }
    source
        .paths
        .iter()
        .any(|path| contains(path, &mut Vec::new()))
}

/// 进入文件夹前查它是否已在正在展开的这条路径上：目录链接（符号链接、Windows 目录联接）
/// 指回上层时不再进入，免得一层层绕回同一批文件。可以进入时记下它，离开时由调用方弹出。
fn enter(dir: &Path, ancestry: &mut Vec<PathBuf>) -> bool {
    let identity = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if ancestry.contains(&identity) {
        return false;
    }
    ancestry.push(identity);
    true
}

/// 展开文件夹（含子文件夹，按名称排序）。读不了的位置记为读取失败；指回上层文件夹的目录链接跳过。
pub(super) fn collect(
    inner: &Inner,
    path: &Path,
    files: &mut Vec<PathBuf>,
    report: &mut ImportReport,
) {
    walk(inner, path, files, report, &mut Vec::new());
}

fn walk(
    inner: &Inner,
    path: &Path,
    files: &mut Vec<PathBuf>,
    report: &mut ImportReport,
    ancestry: &mut Vec<PathBuf>,
) {
    let fail = |report: &mut ImportReport, e: std::io::Error| {
        report.items.push(ImportItem {
            path: path.to_path_buf(),
            outcome: ImportOutcome::ReadFailed { reason: e.into() },
        })
    };
    if let Some(layout) = crate::backup::layout_containing(path) {
        // 备份里的原图按哈希存放，当散图导入会丢掉文件夹、备注与回收站，只能经恢复还原。
        report.items.push(ImportItem {
            path: layout.to_path_buf(),
            outcome: ImportOutcome::ReadFailed {
                reason: CommandError::new(
                    ErrorKind::ImportBackupFolder,
                    "这是图库备份，要在备份设置里恢复",
                ),
            },
        });
        return;
    }
    if eagle::is_library(path) {
        match eagle::collect(inner, path) {
            Ok(collected) => {
                report.from_eagle = true;
                files.extend(collected.items);
                report.eagle_missing += collected.missing;
            }
            Err(eagle::CollectError::Relocation(proposal)) => {
                report.eagle_relocations.push(proposal);
            }
            Err(eagle::CollectError::Failed(reason)) => report.items.push(ImportItem {
                path: path.to_path_buf(),
                outcome: ImportOutcome::ReadFailed { reason },
            }),
        }
        return;
    }
    if eagle::is_item(path) {
        report.from_eagle = true;
        files.push(path.to_path_buf());
        return;
    }
    match std::fs::metadata(path) {
        Err(e) => fail(report, e),
        Ok(meta) if meta.is_dir() => {
            if !enter(path, ancestry) {
                return;
            }
            match std::fs::read_dir(path) {
                Err(e) => fail(report, e),
                Ok(entries) => {
                    let mut children: Vec<PathBuf> =
                        entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                    children.sort();
                    for child in children {
                        walk(inner, &child, files, report, ancestry);
                    }
                }
            }
            ancestry.pop();
        }
        Ok(_) => files.push(path.to_path_buf()),
    }
}
