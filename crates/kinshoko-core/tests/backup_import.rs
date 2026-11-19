//! 把备份文件夹交给普通导入（用户报告：备份交给别人导入后文件夹全没了）：导入前认出备份，从它恢复
//! 最新的完整快照成新资料库；嵌在更深处的备份也不会被拆成散图。

#[path = "support/backup_device.rs"]
mod backup_device;

use backup_device::*;

use std::collections::BTreeSet;

use kinshoko_core::Library;
use kinshoko_core::backup::{BackupError, BackupTarget, target_of};
use kinshoko_core::command_error::ErrorKind;
use kinshoko_core::library::{ImportItem, ImportOutcome, ImportSource};

/// 别人把备份文件夹当普通图片导入时，按哈希存放的原图不会被当散图导入（文件夹、备注、回收站都会丢），
/// 而是指向“恢复”；同一次导入里的其它图片照常导入。
#[test]
fn importing_a_backup_folder_points_to_restore_instead_of_flattening_its_originals() {
    let device = Device::new();
    device.curate();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    assert!(device.backup(&target, at(0, 1)).complete);

    let other = Library::create(&device.dir.path().join("别人的库"), "别人").unwrap();
    other.set_safe_mode(false);
    let picture = png(&device.dir.path().join("别的图.png"), 99);
    let layout = backups.path().join("移动盘").join("kinshoko-backup");
    for chosen in [
        backups.path().join("移动盘"),
        layout.clone(),
        layout.join("originals"),
        layout.join("snapshots"),
    ] {
        let report = other
            .import(ImportSource {
                paths: vec![chosen.clone(), picture.clone()],
            })
            .wait();
        let refused: Vec<&ImportItem> = report.items.iter().filter(|i| i.path != picture).collect();
        assert_eq!(refused.len(), 1, "{chosen:?}: {:?}", report.items);
        assert_eq!(refused[0].path, layout, "{chosen:?}");
        assert!(
            matches!(
                &refused[0].outcome,
                ImportOutcome::ReadFailed { reason } if reason.kind == ErrorKind::ImportBackupFolder
            ),
            "{chosen:?}: {:?}",
            refused[0].outcome
        );
        let sidebar = other.sidebar().unwrap();
        assert_eq!(
            (sidebar.all, sidebar.trash),
            (1, 0),
            "{chosen:?}: 只导入了别的图"
        );
    }
}

/// 把备份文件夹拖进导入时，导入前就认出它（备份目标本身、`kinshoko-backup/` 或里面的文件夹都算），
/// 再从这个位置把最新的完整快照恢复成新图库，文件夹、备注与回收站原样回来。
#[test]
fn a_backup_folder_chosen_for_import_restores_its_latest_snapshot_with_folders() {
    let device = Device::new();
    device.curate();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    assert!(device.backup(&target, at(0, 1)).complete);
    device.main.create_folder("第二次", None).unwrap();
    assert!(device.backup(&target, at(1, 1)).complete);

    let drive = backups.path().join("移动盘");
    let layout = drive.join("kinshoko-backup");
    let picture = png(&device.dir.path().join("别的图.png"), 99);
    for chosen in [
        drive.clone(),
        layout.clone(),
        layout.join("originals"),
        layout.join("snapshots"),
    ] {
        let source = ImportSource {
            paths: vec![chosen.clone(), picture.clone()],
        };
        assert_eq!(
            source.backups(),
            vec![chosen.clone()],
            "只认出备份，不算别的图"
        );
        assert_eq!(target_of(&chosen), Some(drive.clone()), "{chosen:?}");
    }
    assert_eq!(target_of(&picture), None);
    assert_eq!(target_of(device.dir.path()), None);

    let found = BackupTarget::new(&target_of(&layout.join("originals")).unwrap());
    let latest = found.latest_snapshot().unwrap();
    let into = device.dir.path().join("恢复");
    let restored = found
        .restore(&latest.id, &into, &device.groups, at(2, 1))
        .unwrap();
    let main = restored
        .libraries
        .iter()
        .find(|l| l.old_id == device.main.info().id)
        .unwrap();
    let copy = Library::open(&main.library.root).unwrap();
    copy.set_safe_mode(false);
    let names: BTreeSet<String> = copy
        .sidebar()
        .unwrap()
        .folders
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(
        names,
        BTreeSet::from(["眼睛".to_string(), "第二次".to_string()]),
        "恢复的是最新快照"
    );
    assert_eq!(
        copy.image(&device.main_images[0]).unwrap(),
        device.main.image(&device.main_images[0]).unwrap(),
        "备注与文件夹归属都在"
    );
}

#[test]
fn a_backup_target_without_a_complete_snapshot_has_no_latest() {
    let backups = tempfile::tempdir().unwrap();
    assert!(matches!(
        target(backups.path()).latest_snapshot(),
        Err(BackupError::TargetUnavailable(_) | BackupError::UnknownSnapshot)
    ));
}
