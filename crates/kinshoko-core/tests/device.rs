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

#[test]
fn unregistering_forgets_the_location_without_deleting_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = dir.path().join("app");
    let library = Library::create(&dir.path().join("工作参考"), "工作参考").unwrap();
    let id = library.info().id.clone();
    let mut device = DeviceRegistry::open(&app_data).unwrap();
    device.register(library.info()).unwrap();

    device.unregister(&id).unwrap();
    drop(device);
    drop(library);

    let device = DeviceRegistry::open(&app_data).unwrap();
    assert!(device.libraries().is_empty());
    assert_eq!(device.last_opened(), None);
    assert_eq!(
        Library::open(&dir.path().join("工作参考"))
            .unwrap()
            .info()
            .id,
        id
    );
}

/// 保存入口各自记住的位置（ADR-0016）：存在 device.json，跨重启保留。
mod save_memory {
    use kinshoko_core::library::SaveDestination;
    use kinshoko_core::{DeviceLibraries, DeviceRegistry, Library};

    fn destination(library_id: &str, folder_id: Option<&str>) -> SaveDestination {
        SaveDestination {
            library_id: library_id.into(),
            folder_id: folder_id.map(Into::into),
        }
    }

    #[test]
    fn each_entry_remembers_its_own_choice_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let library = Library::create(&dir.path().join("库"), "库").unwrap();
        let id = library.info().id.clone();
        let mut device = DeviceRegistry::open(&app_data).unwrap();
        device.register(library.info()).unwrap();
        assert_eq!(device.save_memory().import_destination, None);
        assert_eq!(device.save_memory().new_library_parent, None);

        let chosen = destination(&id, Some("F1"));
        device.remember_import_destination(&chosen).unwrap();
        device.remember_new_library_parent(dir.path()).unwrap();
        drop(device);

        let device = DeviceRegistry::open(&app_data).unwrap();
        assert_eq!(device.save_memory().import_destination, Some(chosen));
        assert_eq!(
            device.save_memory().new_library_parent.as_deref(),
            Some(dir.path())
        );
    }

    #[test]
    fn a_device_file_from_before_the_memory_opens_with_nothing_remembered() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device.json"),
            r#"{"format":"kinshoko.device","formatVersion":1,"libraries":[],"lastOpened":null}"#,
        )
        .unwrap();

        let device = DeviceRegistry::open(dir.path()).unwrap();
        assert_eq!(device.save_memory().import_destination, None);
    }

    #[test]
    fn unregistering_forgets_a_destination_in_that_library_only() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app");
        let library = Library::create(&dir.path().join("甲"), "甲").unwrap();
        let other = Library::create(&dir.path().join("乙"), "乙").unwrap();
        let mut device = DeviceRegistry::open(&app_data).unwrap();
        device.register(library.info()).unwrap();
        device.register(other.info()).unwrap();
        let chosen = destination(&library.info().id, None);
        device.remember_import_destination(&chosen).unwrap();

        device.unregister(&other.info().id).unwrap();
        assert_eq!(device.save_memory().import_destination, Some(chosen));

        device.unregister(&library.info().id).unwrap();
        assert_eq!(device.save_memory().import_destination, None);
    }

    #[test]
    fn a_destination_in_an_unregistered_library_is_not_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let mut device = DeviceRegistry::open(dir.path()).unwrap();

        device
            .remember_import_destination(&destination("没登记", None))
            .unwrap();

        assert_eq!(device.save_memory().import_destination, None);
    }

    /// 移动盘没插时保留记录，只是这次不拿来预填；插回来后恢复。
    #[test]
    fn a_new_library_parent_that_is_gone_stays_remembered_but_is_not_offered() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("移动盘");
        std::fs::create_dir(&parent).unwrap();
        let mut libraries = DeviceLibraries::open(&dir.path().join("app")).unwrap();
        libraries.remember_new_library_parent(&parent).unwrap();
        assert_eq!(
            libraries.save_memory().new_library_parent.as_deref(),
            Some(parent.as_path())
        );

        std::fs::remove_dir(&parent).unwrap();
        assert_eq!(libraries.save_memory().new_library_parent, None);

        std::fs::create_dir(&parent).unwrap();
        assert_eq!(
            libraries.save_memory().new_library_parent.as_deref(),
            Some(parent.as_path())
        );
    }
}
