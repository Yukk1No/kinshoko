//! 清理原文件区时读不了某份完整快照的清单：那份快照引用的原文件不能当成没人引用而删掉，
//! 否则清单恢复可读后这份快照就恢复不了。

#[path = "support/backup_device.rs"]
mod backup_device;

use backup_device::*;

use std::path::Path;

use kinshoko_core::library::ImageEdit;

/// 第 0 天备份全部原图，再永久删掉主库的一张，第 1 天备份时第 0 天的清单读不了。
/// 清单恢复后，第 0 天的快照仍要能完整恢复。
fn a_snapshot_survives_a_backup_that_could_not_read_its_manifest(
    break_manifest: impl Fn(&Path),
    mend_manifest: impl Fn(&Path),
) {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    let first = device.backup(&target, at(0, 3));
    assert!(first.complete, "{:?}", first.problems);
    let manifest = backups
        .path()
        .join("移动盘")
        .join("kinshoko-backup")
        .join("snapshots")
        .join(&first.snapshot_id)
        .join("manifest.json");
    let saved = std::fs::read(&manifest).unwrap();

    let only_in_first = std::slice::from_ref(&device.main_images[0]);
    device
        .main
        .edit(only_in_first, &[ImageEdit::Delete])
        .unwrap();
    let preview = device
        .main
        .preview_permanent_delete(only_in_first, &device.groups)
        .unwrap();
    device
        .main
        .permanent_delete(only_in_first, &preview.token, &device.groups)
        .unwrap();

    break_manifest(&manifest);
    let second = device.backup(&target, at(1, 3));
    assert!(second.complete, "{:?}", second.problems);
    mend_manifest(&manifest);
    std::fs::write(&manifest, &saved).unwrap();

    let restored = target
        .restore(
            &first.snapshot_id,
            &device.dir.path().join("恢复"),
            &device.groups,
            at(2, 1),
        )
        .expect("清单读不了时清理不删这份快照的原文件");
    assert_eq!(restored.check.originals.checked, 5);
}

#[test]
fn an_unparsable_manifest_keeps_the_originals_only_its_snapshot_references() {
    a_snapshot_survives_a_backup_that_could_not_read_its_manifest(
        |manifest| std::fs::write(manifest, b"{\"format\":").unwrap(),
        |_| {},
    );
}

#[test]
fn an_unreadable_manifest_keeps_the_originals_only_its_snapshot_references() {
    // 清单的位置上是一个目录：在每个平台上都读不了。
    a_snapshot_survives_a_backup_that_could_not_read_its_manifest(
        |manifest| {
            std::fs::remove_file(manifest).unwrap();
            std::fs::create_dir(manifest).unwrap();
        },
        |manifest| std::fs::remove_dir(manifest).unwrap(),
    );
}

/// 快照目录旁边的文件（如系统写的 desktop.ini）不是快照，不挡住清理没人引用的原文件。
#[test]
fn a_file_beside_the_snapshots_does_not_stop_the_cleanup() {
    let device = Device::new();
    let backups = tempfile::tempdir().unwrap();
    let target = target(backups.path());
    device.backup(&target, at(0, 3));
    let layout = backups.path().join("移动盘/kinshoko-backup");
    std::fs::write(layout.join("snapshots/desktop.ini"), b"[.ShellClassInfo]").unwrap();
    let unreferenced = layout.join("originals/00/00unreferenced");
    std::fs::create_dir_all(unreferenced.parent().unwrap()).unwrap();
    std::fs::write(&unreferenced, b"x").unwrap();

    let second = device.backup(&target, at(1, 3));
    assert!(second.complete, "{:?}", second.problems);
    assert!(!unreferenced.exists(), "没人引用的原文件照常清掉");
}

#[test]
fn a_linked_snapshot_keeps_the_originals_only_it_references() {
    // 快照目录是指向别处的目录链接：恢复照样认它，清理也得读它的清单。
    a_snapshot_survives_a_backup_that_could_not_read_its_manifest(
        |manifest| {
            let snapshot = manifest.parent().unwrap();
            let elsewhere = snapshot.parent().unwrap().parent().unwrap().join("别处");
            std::fs::rename(snapshot, &elsewhere).unwrap();
            link_dir(&elsewhere, snapshot);
        },
        |_| {},
    );
}

#[test]
fn a_snapshot_linked_to_a_missing_folder_keeps_the_originals_only_it_references() {
    // 链接还在、链接过去的文件夹暂时不在：看不清这份快照，也就确认不了它引用哪些原文件。
    a_snapshot_survives_a_backup_that_could_not_read_its_manifest(
        |manifest| {
            let snapshot = manifest.parent().unwrap();
            let elsewhere = snapshot.parent().unwrap().parent().unwrap().join("别处");
            std::fs::rename(snapshot, &elsewhere).unwrap();
            link_dir(&elsewhere, snapshot);
            std::fs::rename(&elsewhere, elsewhere.with_file_name("别处-拔掉")).unwrap();
        },
        |manifest| {
            let elsewhere = manifest
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("别处");
            std::fs::rename(elsewhere.with_file_name("别处-拔掉"), &elsewhere).unwrap();
        },
    );
}

fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J 失败");
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).unwrap();
}
