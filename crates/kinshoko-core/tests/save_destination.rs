//! T10 public actions with real PNG files and SQLite libraries.
use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, ImportOptions, ImportSource, SaveDestination,
};
fn query(scope: BrowseScope) -> BrowseQuery {
    BrowseQuery {
        scope,
        conditions: Default::default(),
        cursor: None,
        limit: 100,
        thumbnail_px: 256,
    }
}
#[test]
fn ordinary_import_commits_to_the_explicit_folder_without_changing_other_folders() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "目标库").unwrap();
    let folder = library.create_folder("固定目标", None).unwrap();
    let other = library.create_folder("另一个目录", None).unwrap();
    let png = dir.path().join("reference.png");
    image::RgbImage::from_pixel(18, 22, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let destination = SaveDestination {
        library_id: library.info().id.clone(),
        folder_id: Some(folder.clone()),
    };
    let report = library
        .import_to(
            ImportSource { paths: vec![png] },
            ImportOptions::default(),
            &destination,
        )
        .unwrap()
        .wait();
    assert!(!report.cancelled);
    assert_eq!(
        library
            .browse(&query(BrowseScope::Folder { id: folder }))
            .unwrap()
            .total,
        1,
        "导入与目录归属必须一起提交"
    );
    assert_eq!(
        library
            .browse(&query(BrowseScope::Folder { id: other }))
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        library
            .browse(&query(BrowseScope::Unassigned))
            .unwrap()
            .total,
        0
    );
}

#[test]
fn deleting_the_destination_during_import_reports_remaining_failures_instead_of_falling_back() {
    use kinshoko_core::library::{ImportOutcome, LibraryEvent};
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "目标库").unwrap();
    let folder = library.create_folder("将删除的目标", None).unwrap();
    let png = dir.path().join("reference.png");
    image::RgbImage::from_pixel(18, 22, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let events = library.events();
    let destination = SaveDestination {
        library_id: library.info().id.clone(),
        folder_id: Some(folder.clone()),
    };
    let task = library
        .import_to(
            ImportSource {
                paths: vec![png; 120],
            },
            ImportOptions::default(),
            &destination,
        )
        .unwrap();
    loop {
        match events
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
        {
            LibraryEvent::TaskProgress { progress, .. }
                if progress.done > 0 && progress.done < progress.total =>
            {
                break;
            }
            LibraryEvent::TaskFinished { .. } => {
                panic!("fixture must delete while import is running")
            }
            _ => (),
        }
    }
    // External editor removes the logical folder while a real import is running.
    // Assertions below only use public task reports and library actions.
    let mut external =
        rusqlite::Connection::open(library.info().root.join("library.sqlite")).unwrap();
    external
        .busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let tx = external.transaction().unwrap();
    tx.execute("DELETE FROM folder_member WHERE folder_id=?1", [&folder])
        .unwrap();
    tx.execute("DELETE FROM folder_decision WHERE folder_id=?1", [&folder])
        .unwrap();
    tx.execute("DELETE FROM folder WHERE id=?1", [&folder])
        .unwrap();
    tx.commit().unwrap();
    let report = task.wait();
    assert!(report.items.iter().any(|item| matches!(&item.outcome, ImportOutcome::ReadFailed {reason} if reason.contains("保存目标不可用") || reason.contains("没有这个文件夹"))));
    assert!(
        report
            .items
            .iter()
            .any(|item| item.outcome.image_id().is_some())
    );
    assert_eq!(report.items.len(), 120);
    assert!(
        library
            .import_to(
                ImportSource { paths: vec![] },
                ImportOptions::default(),
                &destination
            )
            .is_err()
    );
}

#[test]
fn task_receipt_keeps_its_owner_after_current_library_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut device = kinshoko_core::DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let a = device.create(&dir.path().join("a"), "原目标库").unwrap();
    let b = device.create(&dir.path().join("b"), "当前浏览库").unwrap();
    let png = dir.path().join("reference.png");
    image::RgbImage::from_pixel(18, 22, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let id = device
        .start_import(
            &a.info().id,
            ImportSource {
                paths: vec![png; 120],
            },
        )
        .unwrap();
    let receipt = device
        .import_tasks()
        .into_iter()
        .find(|t| t.task_id == id)
        .expect("正在运行的真实任务必须可按原目标查询");
    assert_eq!(receipt.destination.library_id, a.info().id);
    assert!(receipt.report.is_none());
    assert_eq!(device.current().unwrap().info().id, b.info().id);
    assert!(
        device.cancel_import(&b.info().id, &id).is_err(),
        "其他库不能取消此任务"
    );
    loop {
        let receipt = device
            .import_tasks()
            .into_iter()
            .find(|t| t.task_id == id)
            .unwrap();
        if let Some(report) = receipt.report {
            assert!(!report.cancelled);
            assert_eq!(report.items.len(), 120);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(a.browse(&query(BrowseScope::All)).unwrap().total, 1);
    assert_eq!(b.browse(&query(BrowseScope::All)).unwrap().total, 0);
}

#[test]
fn screenshot_collection_uses_the_explicit_destination_and_keeps_original_bytes() {
    use kinshoko_core::desktop::{CaptureHistory, Screenshot};
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "收藏库").unwrap();
    let folder = library.create_folder("截图参考", None).unwrap();
    let destination = SaveDestination {
        library_id: library.info().id.clone(),
        folder_id: Some(folder.clone()),
    };
    let target = library.for_destination(&destination).unwrap();
    let mut history = CaptureHistory::open(&dir.path().join("captures")).unwrap();
    let capture = history
        .add(&Screenshot {
            image: image::RgbaImage::from_pixel(37, 21, image::Rgba([60, 20, 40, 255])),
            icc: None,
        })
        .unwrap();
    let before = std::fs::read(history.file(&capture.id).unwrap()).unwrap();
    let collected = history.collect(&capture.id, &target).unwrap();
    assert_eq!(collected.library_id, library.info().id);
    assert_eq!(
        library
            .browse(&query(BrowseScope::Folder { id: folder }))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        std::fs::read(library.original_path(&collected.image_id).unwrap()).unwrap(),
        before
    );
    assert_eq!(history.collect(&capture.id, &target).unwrap(), collected);
}

#[test]
fn copying_keeps_source_provenance_and_the_existing_targets_manual_curation() {
    use kinshoko_core::library::{ImageEdit, TagEdit, TagNamespace, TagRef};
    let dir = tempfile::tempdir().unwrap();
    let source = Library::create(&dir.path().join("source"), "来源库").unwrap();
    let target = Library::create(&dir.path().join("target"), "目标库").unwrap();
    let folder = target.create_folder("复制位置", None).unwrap();
    let png = dir.path().join("source.png");
    image::RgbImage::from_pixel(18, 22, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    source
        .import(ImportSource {
            paths: vec![png.clone()],
        })
        .wait();
    target.import(ImportSource { paths: vec![png] }).wait();
    let source_id = source.browse(&query(BrowseScope::All)).unwrap().cards[0]
        .id
        .clone();
    let target_id = target.browse(&query(BrowseScope::All)).unwrap().cards[0]
        .id
        .clone();
    source
        .edit(
            std::slice::from_ref(&source_id),
            &[ImageEdit::SetNote {
                text: "原来源备注".into(),
            }],
        )
        .unwrap();
    target
        .edit(
            std::slice::from_ref(&target_id),
            &[ImageEdit::SetNote {
                text: "目标独立备注".into(),
            }],
        )
        .unwrap();
    target
        .edit_tags(
            std::slice::from_ref(&target_id),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "目标独立标签".into(),
                    lang: "zh".into(),
                },
            }],
        )
        .unwrap();
    let target_tags = target.image_tags(&target_id, "zh").unwrap();
    let destination = SaveDestination {
        library_id: target.info().id.clone(),
        folder_id: Some(folder.clone()),
    };
    let copied = target
        .for_destination(&destination)
        .unwrap()
        .copy_from(&source, &source_id)
        .unwrap();
    assert_eq!(copied, target_id);
    assert_eq!(
        target.image(&target_id).unwrap().note.manual.as_deref(),
        Some("目标独立备注")
    );
    assert_eq!(target.image_tags(&target_id, "zh").unwrap(), target_tags);
    assert!(
        target
            .image_sources(&target_id)
            .unwrap()
            .iter()
            .any(|s| s.source.contains(&source.info().id)),
        "复制必须保留原资料库来源身份"
    );
    assert_eq!(
        target
            .browse(&query(BrowseScope::Folder { id: folder }))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        source.image(&source_id).unwrap().note.manual.as_deref(),
        Some("原来源备注")
    );
}

#[test]
fn create_reopen_and_unregister_only_affect_their_actual_task_owner() {
    use kinshoko_core::library::LibraryEvent;
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let mut device = kinshoko_core::DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let a = device.create(&dir.path().join("a"), "任务 A").unwrap();
    let b = device.create(&dir.path().join("b"), "任务 B").unwrap();
    let png = dir.path().join("reference.png");
    image::RgbImage::from_pixel(18, 22, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let a = device.write(&a.info().id).unwrap();
    let events = a.events();
    let a_task = device
        .start_import(
            &a.info().id,
            ImportSource {
                paths: vec![png.clone(); 400],
            },
        )
        .unwrap();
    let b_task = device
        .start_import(
            &b.info().id,
            ImportSource {
                paths: vec![png; 400],
            },
        )
        .unwrap();
    loop {
        if let LibraryEvent::TaskProgress { progress, .. } = events
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            && progress.done > 0
            && progress.done < progress.total
        {
            break;
        }
    }
    let c = device.create(&dir.path().join("c"), "新建浏览库").unwrap();
    assert_eq!(device.current().unwrap().info().id, c.info().id);
    let reopened = device.register(&a.info().root).unwrap();
    assert!(
        Arc::ptr_eq(&a, &reopened),
        "重开正在运行的库必须复用原 writer，不重新 reconcile pending"
    );
    device.switch(&b.info().id).unwrap();
    device.unregister(&a.info().id).unwrap();
    let cancelled = device.import_task(&a_task).unwrap();
    assert!(cancelled.report.unwrap().cancelled);
    assert_eq!(device.current().unwrap().info().id, b.info().id);
    loop {
        let receipt = device.import_task(&b_task).unwrap();
        if let Some(report) = receipt.report {
            assert!(!report.cancelled);
            assert_eq!(report.items.len(), 400);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(b.browse(&query(BrowseScope::All)).unwrap().total, 1);
    assert_eq!(c.browse(&query(BrowseScope::All)).unwrap().total, 0);
}

#[allow(dead_code)]
#[path = "support/eagle.rs"]
mod eagle;
#[test]
fn eagle_import_preserves_its_source_folders_and_adds_the_explicit_destination() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("library"), "目标库").unwrap();
    let folder = library.create_folder("用户选择的目标", None).unwrap();
    let fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 3);
    let destination = SaveDestination {
        library_id: library.info().id.clone(),
        folder_id: Some(folder.clone()),
    };
    let report = library
        .import_to(
            ImportSource {
                paths: vec![fixture.root],
            },
            ImportOptions::default(),
            &destination,
        )
        .unwrap()
        .wait();
    assert!(report.from_eagle);
    assert_eq!(report.items.len(), 3);
    assert!(
        report
            .items
            .iter()
            .all(|item| item.outcome.image_id().is_some())
    );
    assert_eq!(
        library
            .browse(&query(BrowseScope::Folder { id: folder }))
            .unwrap()
            .total,
        3
    );
    assert!(
        library
            .sidebar()
            .unwrap()
            .folders
            .iter()
            .any(|folder| folder.name == "发型参考")
    );
}

#[test]
fn publication_failure_stays_on_its_original_task_receipt_after_browsing_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut device = kinshoko_core::DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let a = device.create(&dir.path().join("a"), "原保存库").unwrap();
    let task = device
        .start_import(&a.info().id, ImportSource { paths: vec![] })
        .unwrap();
    device.defer_import_completion(&task).unwrap();
    let b = device.create(&dir.path().join("b"), "新浏览库").unwrap();
    assert!(
        device.import_task(&task).unwrap().finishing,
        "保存内容后的定义发布也必须属于原任务"
    );
    assert!(
        device
            .complete_import_publication(&b.info().id, &task, None)
            .is_err()
    );
    device
        .complete_import_publication(
            &a.info().id,
            &task,
            Some("内容已保存，资料库定义未更新，可在统一标签目录重试".into()),
        )
        .unwrap();
    let receipt = device.import_task(&task).unwrap();
    assert!(!receipt.finishing);
    assert_eq!(receipt.destination.library_id, a.info().id);
    assert_eq!(receipt.warnings.len(), 1);
    assert_eq!(device.current().unwrap().info().id, b.info().id);
}

#[test]
fn a_synchronous_save_keeps_its_writer_and_unregister_revokes_its_bound_destination() {
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let mut device = kinshoko_core::DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let a = device.create(&dir.path().join("a"), "同步保存库").unwrap();
    let owner = device.write(&a.info().id).unwrap();
    let destination = SaveDestination {
        library_id: a.info().id.clone(),
        folder_id: None,
    };
    let bound = owner.for_destination(&destination).unwrap();
    let b = device.create(&dir.path().join("b"), "新浏览库").unwrap();
    let reopened = device.write(&a.info().id).unwrap();
    assert!(
        Arc::ptr_eq(&owner, &reopened),
        "同步保存持有的 writer 也必须跨 current 切换复用"
    );
    device.unregister(&a.info().id).unwrap();
    assert!(
        bound
            .import_to(
                ImportSource { paths: vec![] },
                ImportOptions::default(),
                &destination
            )
            .is_err(),
        "注销必须使原保存上下文失效"
    );
    assert_eq!(device.current().unwrap().info().id, b.info().id);
}
