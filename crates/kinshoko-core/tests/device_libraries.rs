//! 多资料库通过 Rust 核心公开接口验收；使用临时目录中的真 SQLite 和真文件。

use kinshoko_core::library::{
    BrowseQuery, ImageEdit, ImportSource, LibraryEvent, LibraryInfo, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::{DeviceLibraries, Library};

fn query() -> BrowseQuery {
    BrowseQuery {
        scope: Default::default(),
        conditions: Default::default(),
        cursor: None,
        limit: 100,
        thumbnail_px: 256,
    }
}

fn create(root: &std::path::Path, name: &str) -> LibraryInfo {
    Library::create(root, name).unwrap().info().clone()
}

#[test]
fn registered_libraries_can_be_switched_and_the_last_choice_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let a = Library::create(&dir.path().join("工作参考"), "工作参考").unwrap();
    let b = Library::create(&dir.path().join("私人收藏"), "私人收藏").unwrap();
    let (a, b) = (a.info().clone(), b.info().clone());
    let device_dir = dir.path().join("app");
    let mut libraries = DeviceLibraries::open(&device_dir).unwrap();
    assert!(libraries.current().is_none());

    libraries.register(&a.root).unwrap();
    libraries.register(&b.root).unwrap();
    assert_eq!(libraries.current().unwrap().info().id, b.id);
    libraries.switch(&a.id).unwrap();
    assert_eq!(libraries.current().unwrap().info().id, a.id);
    assert_eq!(libraries.libraries().len(), 2);
    drop(libraries);

    let mut reopened = DeviceLibraries::open(&device_dir).unwrap();
    assert_eq!(
        reopened.restore_last_opened().unwrap().unwrap().info().id,
        a.id
    );
}

/// 恢复出的资料库（#69）登记到本设备，但不切换过去，也不改“上次打开”。
#[test]
fn a_restored_library_is_registered_without_switching_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let a = create(&dir.path().join("工作参考"), "工作参考");
    let restored = create(&dir.path().join("工作参考（恢复）"), "工作参考（恢复）");
    let device_dir = dir.path().join("app");
    let mut libraries = DeviceLibraries::open(&device_dir).unwrap();
    libraries.register(&a.root).unwrap();
    libraries.add_registration(&restored.root).unwrap();
    assert_eq!(libraries.current().unwrap().info().id, a.id);
    assert_eq!(libraries.libraries().len(), 2);
    drop(libraries);

    let mut reopened = DeviceLibraries::open(&device_dir).unwrap();
    assert_eq!(
        reopened.restore_last_opened().unwrap().unwrap().info().id,
        a.id
    );
    reopened.switch(&restored.id).unwrap();
}

#[test]
fn unavailable_libraries_stay_registered_and_a_failed_switch_keeps_the_current_library() {
    let dir = tempfile::tempdir().unwrap();
    let a = create(&dir.path().join("工作参考"), "工作参考");
    let b = create(&dir.path().join("移动盘参考"), "移动盘参考");
    let mut libraries = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    libraries.register(&b.root).unwrap();
    libraries.register(&a.root).unwrap();
    std::fs::rename(&b.root, dir.path().join("盘已拔出")).unwrap();

    let entries = libraries.registrations();
    let missing = entries
        .iter()
        .find(|entry| entry.library.id == b.id)
        .unwrap();
    assert!(missing.unavailable.as_ref().unwrap().contains("暂时不可用"));
    let error = libraries.switch(&b.id).err().unwrap().to_string();
    assert!(error.contains("移动盘已连接"));
    assert!(error.contains("重新登记"));
    assert_eq!(libraries.current().unwrap().info().id, a.id);
    assert_eq!(libraries.libraries().len(), 2);
    drop(libraries);
    let mut reopened = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    assert_eq!(
        reopened.restore_last_opened().unwrap().unwrap().info().id,
        a.id
    );
}

#[test]
fn switching_refuses_a_different_library_at_the_registered_location() {
    let dir = tempfile::tempdir().unwrap();
    let a = create(&dir.path().join("工作参考"), "工作参考");
    let b = create(&dir.path().join("私人收藏"), "私人收藏");
    let mut libraries = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    libraries.register(&b.root).unwrap();
    libraries.register(&a.root).unwrap();
    std::fs::rename(&b.root, dir.path().join("已搬家")).unwrap();
    create(&b.root, "另一个库");

    let error = libraries
        .switch(&b.id)
        .err()
        .expect("身份已变，不能打开别的库");
    assert!(error.to_string().contains("另一个资料库"));
    assert_eq!(libraries.current().unwrap().info().id, a.id);
    assert_eq!(libraries.libraries().len(), 2);
}

#[test]
fn relocating_a_library_and_registering_it_again_preserves_identity_originals_and_curation() {
    let dir = tempfile::tempdir().unwrap();
    let device_dir = dir.path().join("app");
    let root = dir.path().join("旧位置");
    let moved = dir.path().join("新位置");
    let mut libraries = DeviceLibraries::open(&device_dir).unwrap();
    let library = libraries.create(&root, "工作参考").unwrap();
    let id = library.info().id.clone();
    let png = dir.path().join("参考.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let bytes = std::fs::read(&png).unwrap();
    library.import(ImportSource { paths: vec![png] }).wait();
    let image_id = library.browse(&query()).unwrap().cards[0].id.clone();
    let folder = library.create_folder("人物", None).unwrap();
    library
        .edit(
            std::slice::from_ref(&image_id),
            &[
                ImageEdit::AddToFolder { folder_id: folder },
                ImageEdit::SetNote {
                    text: "留意左手".into(),
                },
            ],
        )
        .unwrap();
    library
        .edit_tags(
            std::slice::from_ref(&image_id),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "蓝瞳".into(),
                    lang: "zh".into(),
                },
            }],
        )
        .unwrap();
    let detail = library.image(&image_id).unwrap();
    let tags = library.image_tags(&image_id, "zh").unwrap();
    let side = library.sidebar().unwrap();
    drop(library);
    drop(libraries);
    std::fs::rename(&root, &moved).unwrap();

    let mut libraries = DeviceLibraries::open(&device_dir).unwrap();
    assert!(libraries.registrations()[0].unavailable.is_some());
    let library = libraries.register(&moved).unwrap();
    assert_eq!(library.info().id, id);
    assert_eq!(library.image(&image_id).unwrap(), detail);
    assert_eq!(library.image_tags(&image_id, "zh").unwrap(), tags);
    assert_eq!(library.sidebar().unwrap(), side);
    assert_eq!(
        std::fs::read(library.original_path(&image_id).unwrap()).unwrap(),
        bytes
    );
    // 再次登记更新位置，不重复创建身份；登记表可以重建。
    libraries.register(&moved).unwrap();
    assert_eq!(libraries.libraries().len(), 1);
    assert_eq!(libraries.libraries()[0].root, moved);
    drop(library);
    drop(libraries);
    let mut reopened = DeviceLibraries::open(&device_dir).unwrap();
    assert_eq!(
        reopened.restore_last_opened().unwrap().unwrap().info().id,
        id
    );
}

#[test]
fn a_failed_registry_write_keeps_the_current_library_and_registration_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let a = create(&dir.path().join("工作参考"), "工作参考");
    let b = create(&dir.path().join("私人收藏"), "私人收藏");
    let device_dir = dir.path().join("app");
    let mut libraries = DeviceLibraries::open(&device_dir).unwrap();
    libraries.register(&a.root).unwrap();
    // 用真文件系统制造登记表不可写，避免 mock 存储。
    std::fs::create_dir(device_dir.join("device.json.tmp")).unwrap();

    assert!(libraries.register(&b.root).is_err());
    assert_eq!(libraries.current().unwrap().info().id, a.id);
    assert_eq!(libraries.libraries().len(), 1);
    assert!(libraries.unregister(&a.id).is_err());
    assert_eq!(libraries.libraries()[0].id, a.id);
    assert_eq!(libraries.current().unwrap().info().id, a.id);
}

#[test]
fn switching_keeps_import_running_in_its_original_library() {
    let dir = tempfile::tempdir().unwrap();
    let a = Library::create(&dir.path().join("工作参考"), "工作参考").unwrap();
    let b = Library::create(&dir.path().join("私人收藏"), "私人收藏").unwrap();
    let png = dir.path().join("参考.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    a.import(ImportSource {
        paths: vec![png.clone()],
    })
    .wait();
    let (a, b) = (a.info().clone(), b.info().clone());
    let mut libraries = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    libraries.register(&a.root).unwrap();
    libraries.register(&b.root).unwrap();
    libraries.switch(&a.id).unwrap();
    let old = libraries.current().unwrap();
    let events = old.events();
    let task_id = libraries
        .start_import(
            &a.id,
            ImportSource {
                paths: vec![png; 120],
            },
        )
        .unwrap();

    libraries.switch(&b.id).unwrap();

    let report = events
        .iter()
        .find_map(|event| match event {
            LibraryEvent::TaskFinished {
                task_id: id,
                report,
                ..
            } if id == task_id => Some(report),
            _ => None,
        })
        .expect("原库任务继续运行并按原身份返回");
    assert!(!report.cancelled, "浏览切库不得取消原库导入");
    assert_eq!(report.items.len(), 120);
    assert_eq!(old.browse(&query()).unwrap().total, 1);
    assert_eq!(
        libraries.current().unwrap().browse(&query()).unwrap().total,
        0
    );
    assert!(libraries.require(&a.id).is_err(), "旧请求不能取得新库句柄");
    assert_eq!(libraries.require(&b.id).unwrap().info().id, b.id);
}
