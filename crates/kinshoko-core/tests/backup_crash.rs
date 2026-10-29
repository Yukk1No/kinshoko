//! 备份复制到一半被杀（#8 的中断检查）：留下的半成品不会被当成完整备份，恢复拒绝；重跑得到完整备份。
//!
//! 子进程是本测试程序自己：设 `KINSHOKO_FAULT=backup_after_copy@2`，复制第 2 个原文件后立即退出。

use std::path::{Path, PathBuf};
use std::process::Command;

use image::RgbaImage;
use kinshoko_core::backup::{
    BackupError, BackupSources, BackupTarget, ScopeSelection, Stamp, compute_scope,
};
use kinshoko_core::library::ImportSource;
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary};

const CHILD: &str = "child_backs_up_until_the_fault_point";
const DIR_ENV: &str = "KINSHOKO_TEST_BACKUP_DIR";

fn at(hour: i64) -> Stamp {
    Stamp::new(1_791_158_400_000 + hour * 60 * 60 * 1000, 480)
}

fn backup(dir: &Path, when: Stamp) -> Result<kinshoko_core::backup::BackupReport, BackupError> {
    let library = Library::open(&dir.join("库")).unwrap();
    let registry = [RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }];
    let groups = ReferenceGroups::open(&dir.join("reference-groups")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    BackupTarget::new(&dir.join("移动盘")).run(
        &scope,
        &BackupSources {
            libraries: &registry,
            groups: &groups,
        },
        when,
        &mut |_| {},
    )
}

#[test]
#[ignore = "只在故障注入子进程里运行"]
fn child_backs_up_until_the_fault_point() {
    let dir = PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
    backup(&dir, at(1)).unwrap();
}

#[test]
fn a_backup_killed_mid_copy_is_never_taken_for_a_complete_one() {
    let dir = tempfile::tempdir().unwrap();
    {
        let library = Library::create(&dir.path().join("库"), "库").unwrap();
        let paths: Vec<PathBuf> = (0..4u8)
            .map(|i| {
                let p = dir.path().join(format!("in/{i}.png"));
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                RgbaImage::from_fn(5, 5, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                    .save(&p)
                    .unwrap();
                p
            })
            .collect();
        library.import(ImportSource { paths }).wait();
    }
    std::fs::create_dir_all(dir.path().join("移动盘")).unwrap();

    let status = Command::new(std::env::current_exe().unwrap())
        .args([CHILD, "--exact", "--ignored", "--nocapture"])
        .env(DIR_ENV, dir.path())
        .env("KINSHOKO_FAULT", "backup_after_copy@2")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(99), "子进程在注入点退出");

    let snapshots = dir.path().join("移动盘/kinshoko-backup/snapshots");
    let left: Vec<String> = std::fs::read_dir(&snapshots)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left.len(), 1);
    assert!(left[0].ends_with(".incomplete"));

    let target = BackupTarget::new(&dir.path().join("移动盘"));
    assert!(target.snapshots().unwrap().is_empty());
    let groups = ReferenceGroups::open(&dir.path().join("reference-groups")).unwrap();
    let err = target
        .restore(&left[0], &dir.path().join("恢复"), &groups, at(2))
        .unwrap_err();
    assert!(matches!(err, BackupError::Incomplete(_)), "{err}");
    let id = left[0].trim_end_matches(".incomplete");
    assert!(matches!(
        target.restore(id, &dir.path().join("恢复"), &groups, at(2)),
        Err(BackupError::Incomplete(_))
    ));

    // 重跑：已复制的原文件直接引用，得到完整备份，半成品清掉。
    let report = backup(dir.path(), at(3)).unwrap();
    assert!(report.complete);
    assert_eq!((report.copied, report.reused), (2, 2));
    assert_eq!(target.snapshots().unwrap().len(), 1);
    assert_eq!(std::fs::read_dir(&snapshots).unwrap().count(), 1);
    let restored = target
        .restore(
            &report.snapshot_id,
            &dir.path().join("恢复"),
            &groups,
            at(4),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
}
