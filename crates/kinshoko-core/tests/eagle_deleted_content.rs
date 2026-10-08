//! #78 T14（故事 38–40）：通过公开导入、永久删除与真实 Eagle 文件验证删除决定。
#[path = "support/eagle.rs"]
mod eagle;

use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::library::{
    EagleDeletedContentChoice, ImageEdit, ImportOptions, ImportReport, ImportSource,
};
use kinshoko_core::reference_groups::ReferenceGroups;

fn import(library: &Library, path: &Path) -> ImportReport {
    library
        .import(ImportSource {
            paths: vec![path.to_path_buf()],
        })
        .wait()
}

fn delete(library: &Library, image_id: &str, groups: &ReferenceGroups) {
    let ids = vec![image_id.to_owned()];
    library.edit(&ids, &[ImageEdit::Delete]).unwrap();
    let preview = library.preview_permanent_delete(&ids, groups).unwrap();
    library
        .permanent_delete(&ids, &preview.token, groups)
        .unwrap();
}

#[test]
fn permanently_deleted_eagle_content_stays_skipped_after_restart_in_this_library_only() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("source.library"), version, 1);
        let root = dir.path().join("target");
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        let library = Library::create(&root, "参考").unwrap();
        let report = import(&library, &fixture.root);
        let id = report.items[0].outcome.image_id().unwrap().to_owned();
        let original = library.original_path(&id).unwrap();
        delete(&library, &id, &groups);
        assert!(!original.exists());
        drop(library);

        let library = Library::open(&root).unwrap();
        for _ in 0..3 {
            let report = import(&library, &fixture.root);
            assert_eq!(
                serde_json::to_value(&report.items[0].outcome).unwrap()["kind"],
                "skippedDeleted",
                "{report:?}"
            );
            assert_eq!(library.sidebar().unwrap().all, 0);
            assert!(library.eagle_sources().unwrap()[0].bindings.is_empty());
        }
        let other = Library::create(&dir.path().join("other"), "另一个资料库").unwrap();
        assert!(
            import(&other, &fixture.root).items[0]
                .outcome
                .image_id()
                .is_some()
        );
    }
}

#[test]
fn allowing_one_import_keeps_the_memory_but_allows_normal_refresh_until_deleted_again() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("source.library"), version, 1);
        let root = dir.path().join("target");
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        let library = Library::create(&root, "参考").unwrap();
        let first = import(&library, &fixture.root).items[0]
            .outcome
            .image_id()
            .unwrap()
            .to_owned();
        delete(&library, &first, &groups);
        let allowed = library
            .import_with_options(
                ImportSource {
                    paths: vec![fixture.root.clone()],
                },
                ImportOptions {
                    eagle_deleted_content: EagleDeletedContentChoice::AllowThisImport,
                },
            )
            .wait();
        let id = allowed.items[0]
            .outcome
            .image_id()
            .expect("本次明确允许重导")
            .to_owned();
        assert_ne!(id, first);

        let folder = library.create_folder("我的整理", None).unwrap();
        library
            .edit(
                std::slice::from_ref(&id),
                &[
                    ImageEdit::SetNote {
                        text: "本库备注".into(),
                    },
                    ImageEdit::AddToFolder {
                        folder_id: folder.clone(),
                    },
                ],
            )
            .unwrap();
        fixture.items[0]["annotation"] = serde_json::json!("Eagle 改了备注");
        fixture.save_item(0);
        let refreshed = import(&library, &fixture.root);
        assert_eq!(
            serde_json::to_value(&refreshed.items[0].outcome).unwrap()["kind"],
            "refreshed"
        );
        assert_eq!(refreshed.items[0].outcome.image_id(), Some(id.as_str()));
        let detail = library.image(&id).unwrap();
        assert_eq!(detail.note.manual.as_deref(), Some("本库备注"));
        assert_eq!(detail.note.sources[0].text, "Eagle 改了备注");
        assert!(detail.folders.iter().any(|f| f.id == folder));
        delete(&library, &id, &groups);
        drop(library);

        let library = Library::open(&root).unwrap();
        let report = import(&library, &fixture.root);
        assert_eq!(
            serde_json::to_value(&report.items[0].outcome).unwrap()["kind"],
            "skippedDeleted",
            "允许一次不应遗忘删除决定：{report:?}"
        );
        assert_eq!(library.sidebar().unwrap().all, 0);
    }
}

#[test]
fn trash_duplicates_offer_the_existing_image_without_restoring_it() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("source.library"), version, 1);
        let library = Library::create(&dir.path().join("target"), "参考").unwrap();
        let report = import(&library, &fixture.root);
        let id = report.items[0].outcome.image_id().unwrap().to_owned();
        library
            .edit(std::slice::from_ref(&id), &[ImageEdit::Delete])
            .unwrap();
        for _ in 0..2 {
            let report = import(&library, &fixture.root);
            assert_eq!(
                serde_json::to_value(&report.items[0].outcome).unwrap()["kind"],
                "trashDuplicate",
                "{report:?}"
            );
            assert_eq!(report.items[0].outcome.image_id(), Some(id.as_str()));
            assert!(library.image(&id).unwrap().deleted_at.is_some());
            assert_eq!(library.sidebar().unwrap().all, 0);
            assert_eq!(library.sidebar().unwrap().trash, 1);
        }
        library
            .edit(std::slice::from_ref(&id), &[ImageEdit::Restore])
            .unwrap();
        assert_eq!(library.sidebar().unwrap().all, 1);
        assert_eq!(
            import(&library, &fixture.root).items[0].outcome.image_id(),
            Some(id.as_str())
        );
    }
}

#[test]
fn eagle_choice_preflight_recognizes_selected_parent_and_item_without_registering_a_source() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("parent/source.library"), "4.0.0", 1);
    let library = Library::create(&dir.path().join("target"), "参考").unwrap();
    for path in [
        &fixture.root,
        &dir.path().join("parent"),
        &fixture.item_dir(0),
    ] {
        assert!(
            ImportSource {
                paths: vec![path.to_path_buf()]
            }
            .contains_eagle()
        );
    }
    assert!(
        !ImportSource {
            paths: vec![fixture.original(0)]
        }
        .contains_eagle()
    );
    assert!(
        library.eagle_sources().unwrap().is_empty(),
        "取消选择前的预检不得登记来源"
    );
    assert_eq!(library.sidebar().unwrap().all, 0);
}

#[test]
fn the_same_eagle_item_can_import_new_bytes_while_the_deleted_version_remains_skipped() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("source.library"), version, 1);
        let root = dir.path().join("target");
        let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
        let library = Library::create(&root, "参考").unwrap();
        let first = import(&library, &fixture.root).items[0]
            .outcome
            .image_id()
            .unwrap()
            .to_owned();
        let old = std::fs::read(fixture.original(0)).unwrap();
        delete(&library, &first, &groups);
        image::RgbaImage::from_pixel(31, 13, image::Rgba([99, 20, 30, 255]))
            .save(fixture.original(0))
            .unwrap();
        let new = std::fs::read(fixture.original(0)).unwrap();
        fixture.items[0]["size"] = serde_json::json!(new.len());
        fixture.items[0]["width"] = serde_json::json!(31);
        fixture.items[0]["height"] = serde_json::json!(13);
        fixture.save_item(0);
        let report = import(&library, &fixture.root);
        let id = report.items[0]
            .outcome
            .image_id()
            .expect("新字节应可导入")
            .to_owned();
        assert_ne!(id, first);
        assert_eq!(
            std::fs::read(library.original_path(&id).unwrap()).unwrap(),
            new
        );
        assert_eq!(library.sidebar().unwrap().all, 1);

        std::fs::write(fixture.original(0), &old).unwrap();
        fixture.items[0]["size"] = serde_json::json!(old.len());
        fixture.items[0]["width"] = serde_json::json!(20);
        fixture.items[0]["height"] = serde_json::json!(20);
        fixture.save_item(0);
        drop(library);
        let library = Library::open(&root).unwrap();
        let report = import(&library, &fixture.root);
        assert_eq!(
            serde_json::to_value(&report.items[0].outcome).unwrap()["kind"],
            "skippedDeleted"
        );
        assert_eq!(
            std::fs::read(library.original_path(&id).unwrap()).unwrap(),
            new
        );
        assert_eq!(library.sidebar().unwrap().all, 1);
    }
}

#[test]
fn a_failed_allowed_import_does_not_forget_the_deleted_version_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 1);
    let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
    let library = Library::create(&dir.path().join("target"), "参考").unwrap();
    let id = import(&library, &fixture.root).items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let original = std::fs::read(fixture.original(0)).unwrap();
    delete(&library, &id, &groups);
    std::fs::remove_file(fixture.original(0)).unwrap();
    let options = ImportOptions {
        eagle_deleted_content: EagleDeletedContentChoice::AllowThisImport,
    };
    let failed = library
        .import_with_options(
            ImportSource {
                paths: vec![fixture.root.clone()],
            },
            options,
        )
        .wait();
    let retry = failed.retry_source().expect("读取失败有重试来源");
    assert!(library.eagle_sources().unwrap()[0].bindings.is_empty());
    std::fs::write(fixture.original(0), &original).unwrap();
    fixture.items[0]["size"] = serde_json::json!(original.len());
    fixture.save_item(0);
    assert_eq!(
        serde_json::to_value(&import(&library, &fixture.root).items[0].outcome).unwrap()["kind"],
        "skippedDeleted"
    );
    let retried = library.import_with_options(retry, options).wait();
    let restored = retried.items[0].outcome.image_id().unwrap();
    assert_eq!(
        std::fs::read(library.original_path(restored).unwrap()).unwrap(),
        original
    );
    assert_eq!(library.eagle_sources().unwrap()[0].bindings.len(), 1);
}

#[test]
#[ignore = "只在故障注入子进程里运行"]
fn child_deletes_eagle_until_fault() {
    let root = std::env::var_os("KINSHOKO_TEST_LIBRARY").unwrap();
    let library = Library::open(Path::new(&root)).unwrap();
    let groups = ReferenceGroups::open(&Path::new(&root).join("groups")).unwrap();
    delete(
        &library,
        &std::env::var("KINSHOKO_TEST_IMAGE").unwrap(),
        &groups,
    );
    panic!("未在永久删除提交后中断");
}

#[test]
fn deletion_memory_is_committed_before_file_cleanup_and_survives_interruption() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 1);
    let root = dir.path().join("target");
    let library = Library::create(&root, "参考").unwrap();
    let id = import(&library, &fixture.root).items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let original = library.original_path(&id).unwrap();
    drop(library);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "child_deletes_eagle_until_fault",
            "--test-threads=1",
        ])
        .env("KINSHOKO_FAULT", "permanent_delete_after_commit")
        .env("KINSHOKO_TEST_LIBRARY", &root)
        .env("KINSHOKO_TEST_IMAGE", &id)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(99));
    let library = Library::open(&root).unwrap();
    assert!(!original.exists(), "重开完成中断的清除");
    assert_eq!(
        serde_json::to_value(&import(&library, &fixture.root).items[0].outcome).unwrap()["kind"],
        "skippedDeleted"
    );
    assert!(library.recovery().orphans.is_empty());
}

#[test]
#[ignore = "只在故障注入子进程里运行"]
fn child_allows_eagle_import_until_fault() {
    let root = std::env::var_os("KINSHOKO_TEST_LIBRARY").unwrap();
    let source = std::env::var_os("KINSHOKO_TEST_EAGLE").unwrap();
    Library::open(Path::new(&root))
        .unwrap()
        .import_with_options(
            ImportSource {
                paths: vec![source.into()],
            },
            ImportOptions {
                eagle_deleted_content: EagleDeletedContentChoice::AllowThisImport,
            },
        )
        .wait();
    panic!("未在允许重导提交前中断");
}

#[test]
fn interrupted_allowed_import_keeps_deleted_memory_and_source_binding_consistent_on_retry() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 1);
    let root = dir.path().join("target");
    let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
    let library = Library::create(&root, "参考").unwrap();
    let id = import(&library, &fixture.root).items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    delete(&library, &id, &groups);
    drop(library);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "child_allows_eagle_import_until_fault",
            "--test-threads=1",
        ])
        .env("KINSHOKO_FAULT", "import_before_commit")
        .env("KINSHOKO_TEST_LIBRARY", &root)
        .env("KINSHOKO_TEST_EAGLE", &fixture.root)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(99));
    let library = Library::open(&root).unwrap();
    assert_eq!(library.recovery().interrupted.len(), 1);
    assert!(library.recovery().orphans.is_empty());
    assert!(library.eagle_sources().unwrap()[0].bindings.is_empty());
    assert_eq!(
        serde_json::to_value(&import(&library, &fixture.root).items[0].outcome).unwrap()["kind"],
        "skippedDeleted"
    );
    let report = library
        .import_with_options(
            ImportSource {
                paths: vec![fixture.root.clone()],
            },
            ImportOptions {
                eagle_deleted_content: EagleDeletedContentChoice::AllowThisImport,
            },
        )
        .wait();
    let id = report.items[0].outcome.image_id().unwrap();
    assert_eq!(library.eagle_sources().unwrap()[0].bindings.len(), 1);
    assert_eq!(
        std::fs::read(library.original_path(id).unwrap()).unwrap(),
        std::fs::read(fixture.original(0)).unwrap()
    );
}

#[test]
fn a_live_duplicate_never_restores_initial_eagle_trash_created_in_a_previous_task() {
    for restart in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 2);
        std::fs::copy(fixture.original(0), fixture.original(1)).unwrap();
        fixture.items[0]["isDeleted"] = serde_json::json!(true);
        fixture.items[1]["size"] = fixture.items[0]["size"].clone();
        fixture.save_item(0);
        fixture.save_item(1);
        let root = dir.path().join("target");
        let mut library = Library::create(&root, "参考").unwrap();
        let first = import(&library, &fixture.item_dir(0));
        let id = first.items[0].outcome.image_id().unwrap().to_owned();
        if restart {
            drop(library);
            library = Library::open(&root).unwrap();
        }
        let second = import(&library, &fixture.item_dir(1));
        assert!(
            library.image(&id).unwrap().deleted_at.is_some(),
            "已有回收站副本不能由新来源恢复：{second:?}"
        );
        assert_eq!(
            serde_json::to_value(&second.items[0].outcome).unwrap()["kind"],
            "trashDuplicate"
        );
    }
}

#[test]
fn cancelled_and_failed_retries_do_not_promote_an_already_created_initial_trash_item() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 40);
    let bytes = std::fs::read(fixture.original(0)).unwrap();
    for index in 0..40 {
        std::fs::write(fixture.original(index), &bytes).unwrap();
        fixture.items[index]["size"] = serde_json::json!(bytes.len());
        fixture.items[index]["isDeleted"] = serde_json::json!(index == 0);
        fixture.save_item(index);
    }
    let root = dir.path().join("target");
    let library = Library::create(&root, "参考").unwrap();
    let id = import(&library, &fixture.item_dir(0)).items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let task = library.import(ImportSource {
        paths: vec![fixture.root.clone()],
    });
    task.cancel();
    assert!(task.wait().cancelled);
    std::fs::remove_file(fixture.original(1)).unwrap();
    let failed = import(&library, &fixture.item_dir(1));
    let retry = failed.retry_source().unwrap();
    std::fs::write(fixture.original(1), &bytes).unwrap();
    drop(library);
    let library = Library::open(&root).unwrap();
    let retried = library.import(retry).wait();
    assert_eq!(
        serde_json::to_value(&retried.items[0].outcome).unwrap()["kind"],
        "trashDuplicate"
    );
    assert!(library.image(&id).unwrap().deleted_at.is_some());
    let all = import(&library, &fixture.root);
    assert!(all.items.iter().all(|item| matches!(
        item.outcome,
        kinshoko_core::library::ImportOutcome::TrashDuplicate { .. }
    )));
    assert_eq!(library.sidebar().unwrap().all, 0);
    assert_eq!(library.sidebar().unwrap().trash, 1);
}

#[test]
fn permanent_delete_respects_an_interrupted_allowed_imports_pending_original_then_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("source.library"), "4.0.0", 1);
    let root = dir.path().join("target");
    let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
    let library = Library::create(&root, "参考").unwrap();
    let id = import(&library, &fixture.root).items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let original = library.original_path(&id).unwrap();
    // 子进程在已有内容的显式允许导入中留下 pending。父进程同时仍持有公开 Library 句柄。
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "child_allows_eagle_import_until_fault",
            "--test-threads=1",
        ])
        .env("KINSHOKO_FAULT", "import_after_pending")
        .env("KINSHOKO_TEST_LIBRARY", &root)
        .env("KINSHOKO_TEST_EAGLE", &fixture.root)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(99));
    delete(&library, &id, &groups);
    assert!(original.exists(), "进行中导入的 pending 仍保护原图");
    drop(library);
    let library = Library::open(&root).unwrap();
    assert!(!original.exists(), "重开撤回导入，再完成永久删除的文件清除");
    assert!(library.recovery().orphans.is_empty());
    assert_eq!(
        serde_json::to_value(&import(&library, &fixture.root).items[0].outcome).unwrap()["kind"],
        "skippedDeleted"
    );
    let report = library
        .import_with_options(
            ImportSource {
                paths: vec![fixture.root.clone()],
            },
            ImportOptions {
                eagle_deleted_content: EagleDeletedContentChoice::AllowThisImport,
            },
        )
        .wait();
    assert_eq!(
        std::fs::read(
            library
                .original_path(report.items[0].outcome.image_id().unwrap())
                .unwrap()
        )
        .unwrap(),
        std::fs::read(fixture.original(0)).unwrap()
    );
}
