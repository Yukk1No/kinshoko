//! 应用壳：本设备登记的资料库（#44）。登记表可重建，不保存整理结果。

use kinshoko_core::{DeviceRegistry, Library};

#[test]
fn a_registered_library_is_remembered_as_the_last_opened_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = dir.path().join("app");
    let library = Library::create(&dir.path().join("参考库"), "参考库").unwrap();

    let mut device = DeviceRegistry::open(&app_data).unwrap();
    assert!(device.libraries().is_empty());
    assert_eq!(device.last_opened(), None);
    device.register(library.info()).unwrap();
    // 再次登记同一个资料库不会重复。
    device.register(library.info()).unwrap();
    drop(device);

    let device = DeviceRegistry::open(&app_data).unwrap();
    assert_eq!(device.libraries().len(), 1);
    let entry = &device.libraries()[0];
    assert_eq!(entry.id, library.info().id);
    assert_eq!(entry.name, "参考库");
    assert_eq!(entry.root, library.info().root);
    assert_eq!(device.last_opened(), Some(entry));
}

#[test]
fn a_library_cannot_be_created_in_a_folder_that_already_has_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("别的文件.txt"), "x").unwrap();

    assert!(Library::create(dir.path(), "库").is_err());
    assert!(Library::open(dir.path()).is_err());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
