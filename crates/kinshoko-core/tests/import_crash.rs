//! 导入在任何一步崩溃都不留下半张图或幽灵记录（#46）。
//!
//! Library 内部的故障注入点由环境变量 `KINSHOKO_FAULT=<注入点>@<第几次>` 打开，
//! 命中时进程立即退出（退出码 99），不运行任何析构。测试把本测试程序自己作为子进程启动，
//! 让子进程在注入点崩溃，再在父进程里通过对外接口重开资料库并检查。

use std::path::{Path, PathBuf};
use std::process::Command;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{BrowseQuery, ImportOutcome, ImportReport, ImportSource};
use sha2::{Digest, Sha256};

const CHILD: &str = "child_imports_until_the_fault_point";
const ROOT_ENV: &str = "KINSHOKO_TEST_LIBRARY";
const FILES_ENV: &str = "KINSHOKO_TEST_FILES";

fn write_png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(12, 8, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn import(library: &Library, paths: &[PathBuf]) -> ImportReport {
    library
        .import(ImportSource {
            paths: paths.to_vec(),
        })
        .wait()
}

fn count(library: &Library) -> u32 {
    library
        .browse(&BrowseQuery {
            scope: Default::default(),
            cursor: None,
            limit: 1,
            thumbnail_px: 256,
        })
        .unwrap()
        .total
}

/// 资料库里某个子文件夹下的全部文件（相对该文件夹）。
fn files_under(dir: &Path) -> Vec<PathBuf> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.map(Result::unwrap) {
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                out.push(path.strip_prefix(base).unwrap().to_path_buf());
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// 子进程：打开资料库，导入，在注入点崩溃。走到最后说明注入点没有命中。
#[test]
#[ignore = "只在故障注入子进程里运行"]
fn child_imports_until_the_fault_point() {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap());
    let files = std::env::split_paths(&std::env::var_os(FILES_ENV).unwrap()).collect::<Vec<_>>();
    let library = Library::open(&root).unwrap();
    import(&library, &files);
    panic!("没有在注入点崩溃");
}

fn crash_while_importing(fault: &str, root: &Path, files: &[PathBuf]) {
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", CHILD, "--test-threads=1"])
        .env("KINSHOKO_FAULT", fault)
        .env(ROOT_ENV, root)
        .env(FILES_ENV, std::env::join_paths(files).unwrap())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(99), "子进程应在 {fault} 崩溃");
}

/// 三张图，第二张在注入点崩溃：第一张完整进库，第二、三张没有任何痕迹，
/// 重开时对账给出被撤回的项（暂存阶段还没有 pending 记录，只清掉暂存文件），重试后补齐。
fn crash_at_the_second_item(point: &str, interrupted_is_listed: bool) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    drop(Library::create(&root, "库").unwrap());
    let files: Vec<PathBuf> = (0..3)
        .map(|i| write_png(&dir.path().join(format!("in/{i}.png")), i))
        .collect();
    let bytes: Vec<Vec<u8>> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();

    crash_while_importing(&format!("{point}@2"), &root, &files);

    let library = Library::open(&root).unwrap();
    assert_eq!(count(&library), 1, "{point}：只有第一张进了库");
    let recovery = library.recovery();
    let expected: Vec<PathBuf> = if interrupted_is_listed {
        vec![std::path::absolute(&files[1]).unwrap()]
    } else {
        vec![]
    };
    assert_eq!(recovery.interrupted, expected, "{point}：撤回的项");
    assert_eq!(recovery.orphans, Vec::<PathBuf>::new(), "{point}：孤立文件");
    // 没有半张图：原文件只有第一张，字节不变；暂存已清空。
    let sha0 = sha256(&bytes[0]);
    assert_eq!(
        files_under(&root.join("originals")),
        vec![PathBuf::from(&sha0[..2]).join(format!("{sha0}.png"))],
        "{point}：原文件"
    );
    assert_eq!(
        std::fs::read(
            root.join("originals")
                .join(&sha0[..2])
                .join(format!("{sha0}.png"))
        )
        .unwrap(),
        bytes[0]
    );
    assert_eq!(files_under(&root.join(".staging")), Vec::<PathBuf>::new());
    // 源文件不受影响。
    for (f, b) in files.iter().zip(&bytes) {
        assert_eq!(&std::fs::read(f).unwrap(), b);
    }

    // 重试全部：第一张合并，其余补上，不重复。
    let retry = import(&library, &files);
    let kinds: Vec<bool> = retry
        .items
        .iter()
        .map(|i| matches!(i.outcome, ImportOutcome::Imported { .. }))
        .collect();
    assert_eq!(kinds, vec![false, true, true], "{point}：{retry:?}");
    assert_eq!(count(&library), 3);
    drop(library);

    // 对账只做一次：再次打开没有新的撤回项。
    let again = Library::open(&root).unwrap();
    assert!(again.recovery().interrupted.is_empty());
    assert_eq!(count(&again), 3);
}

#[test]
fn a_crash_after_staging_leaves_no_trace() {
    crash_at_the_second_item("import_after_staging", false);
}

#[test]
fn a_crash_after_the_pending_record_is_rolled_back_on_reopen() {
    crash_at_the_second_item("import_after_pending", true);
}

#[test]
fn a_crash_after_publishing_the_original_removes_it_on_reopen() {
    crash_at_the_second_item("import_after_publish", true);
}

#[test]
fn a_crash_before_commit_leaves_no_record_and_no_original() {
    crash_at_the_second_item("import_before_commit", true);
}

#[test]
fn unknown_files_among_the_originals_are_reported_but_kept() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let library = Library::create(&root, "库").unwrap();
    import(&library, &[write_png(&dir.path().join("in/a.png"), 1)]);
    drop(library);
    let stray = root.join("originals/ab/不认识的文件.png");
    std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
    std::fs::write(&stray, b"not ours").unwrap();

    let library = Library::open(&root).unwrap();

    assert_eq!(
        library.recovery().orphans,
        vec![PathBuf::from("originals/ab/不认识的文件.png")]
    );
    assert!(library.recovery().interrupted.is_empty());
    assert_eq!(std::fs::read(&stray).unwrap(), b"not ours");
    assert_eq!(count(&library), 1);
}
