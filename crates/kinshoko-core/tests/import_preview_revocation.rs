//! 导入预览回执的撤销与收窄：关闭、换代、删除、断开与身份替换（从 import_preview.rs 原样搬出）。
use super::*;

#[test]
fn close_and_next_receipt_generation_reject_late_bytes_foreign_ids_and_historical_tokens() {
    let mut f = Fixture::new();
    let first = f.open();
    let read = f.resolve(&first);
    let bytes = f
        .workspace
        .complete_import_preview(&mut f.device, &mut f.catalog, read, true)
        .unwrap();
    assert_eq!(bytes.bytes(), std::fs::read(&f.same).unwrap());
    let late = f.resolve(&first);
    f.device.close_import_preview(Some(&first.id));
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, late, true)
            .is_err()
    );
    assert!(
        f.workspace
            .prepare_import_preview(
                &mut f.device,
                &mut f.catalog,
                &first.id,
                &first.items[0],
                true,
                240
            )
            .is_err()
    );
    let second_task = receipt(&mut f.device, &f.target.info().id, vec![f.same.clone()]);
    let reopened = f.open();
    let late = f.resolve(&reopened);
    let next = f
        .workspace
        .open_import_preview(
            &mut f.device,
            &mut f.catalog,
            &f.target.info().id,
            &second_task,
            true,
        )
        .unwrap();
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, late, true)
            .is_err()
    );
    assert!(
        f.workspace
            .prepare_import_preview(
                &mut f.device,
                &mut f.catalog,
                &next.id,
                &reopened.items[0],
                true,
                240
            )
            .is_err()
    );
    assert!(
        f.workspace
            .prepare_import_preview(
                &mut f.device,
                &mut f.catalog,
                &next.id,
                &f.target_image,
                true,
                240
            )
            .is_err(),
        "a real image ID is not an authorized opaque receipt item"
    );
    f.device.close_import_preview(Some(&reopened.id));
    let read = f.resolve(&next);
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, read, true)
            .is_ok(),
        "old close cannot cancel a newer consent"
    );
    assert!(
        f.workspace
            .open_import_preview(
                &mut f.device,
                &mut f.catalog,
                &f.adult.as_ref().unwrap().info().id,
                &second_task,
                true
            )
            .is_err()
    );
    assert!(
        f.workspace
            .open_import_preview(
                &mut f.device,
                &mut f.catalog,
                &f.target.info().id,
                "foreign-task",
                true
            )
            .is_err()
    );
    assert!(f.target.safe_mode());
}

#[test]
fn mixed_receipt_coarsens_all_successes_keeps_real_failures_and_does_not_change_curation() {
    use kinshoko_core::library::{TagEdit, TagNamespace, TagRef};
    let mut f = Fixture::new();
    f.target
        .edit(
            std::slice::from_ref(&f.target_image),
            &[ImageEdit::SetNote {
                text: "keep manual note".into(),
            }],
        )
        .unwrap();
    f.target
        .edit_tags(
            std::slice::from_ref(&f.target_image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "private-duplicate-only".into(),
                    lang: "en".into(),
                },
            }],
        )
        .unwrap();
    let visible = png(f.dir.path(), "visible-unknown.png", 140);
    let vi = import(&f.target, &visible);
    let new = png(f.dir.path(), "new-unknown.png", 160);
    let failed = f.dir.path().join("missing-file.png");
    let before = f.target.content_snapshot(&f.target_image).unwrap();
    let original = std::fs::read(f.target.original_path(&f.target_image).unwrap()).unwrap();
    let task = receipt(
        &mut f.device,
        &f.target.info().id,
        vec![f.same.clone(), visible, new, failed.clone()],
    );
    let receipts = f
        .workspace
        .import_receipts(&mut f.device, &mut f.catalog, true)
        .unwrap();
    let r = receipts.into_iter().find(|r| r.task_id == task).unwrap();
    assert_eq!(
        (r.progress.done, r.progress.total),
        (0, 0),
        "completed private totals cannot reveal the hidden subset"
    );
    let raw = f.device.import_task(&task).unwrap();
    assert_eq!(
        (raw.progress.done, raw.progress.total),
        (4, 4),
        "the real task owner retains useful normal processing progress"
    );
    let report = r.report.unwrap();
    assert!(report.private_summary && report.sealed_duplicates);
    assert_eq!(
        report.items.len(),
        1,
        "all success categories are coarsened, not just the sealed rows"
    );
    assert_eq!(report.items[0].path, failed);
    assert!(report.retry_source().unwrap().paths.contains(&failed));
    let session = f
        .workspace
        .open_import_preview(
            &mut f.device,
            &mut f.catalog,
            &f.target.info().id,
            &task,
            true,
        )
        .unwrap();
    assert_eq!(
        session.items.len(),
        1,
        "unknown normal duplicates and new images do not enter the consent set"
    );
    let read = f.resolve(&session);
    f.workspace
        .complete_import_preview(&mut f.device, &mut f.catalog, read, true)
        .unwrap();
    assert_eq!(f.target.content_snapshot(&f.target_image).unwrap(), before);
    assert_eq!(
        std::fs::read(f.target.original_path(&f.target_image).unwrap()).unwrap(),
        original
    );
    assert!(f.target.image_rating(&vi).unwrap().effective.is_none());
    let page = f
        .workspace
        .browse(
            &f.device,
            &mut f.catalog,
            &WorkspaceQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 30,
                thumbnail_px: 240,
            },
            true,
        )
        .unwrap();
    assert_eq!(page.total, 2);
    assert!(
        f.workspace
            .candidates(
                &f.device,
                &mut f.catalog,
                "private-duplicate-only",
                "en",
                20,
                true,
                &Default::default()
            )
            .unwrap()
            .is_empty()
    );
    assert!(f.target.safe_mode());
}

#[test]
fn unavailable_known_adult_source_still_seals_receipts_and_removal_revokes_pending_content() {
    let mut f = Fixture::new();
    let receipts = f
        .workspace
        .import_receipts(&mut f.device, &mut f.catalog, true)
        .unwrap();
    assert!(
        receipts
            .iter()
            .find(|r| r.task_id == f.task)
            .unwrap()
            .report
            .as_ref()
            .unwrap()
            .sealed_duplicates
    );
    let adult = f.adult.take().unwrap();
    let adult_id = adult.info().id.clone();
    let root = adult.info().root.clone();
    drop(adult);
    // 长期只读句柄（#313）握着时 Windows 上改不了名：模拟断开前先放掉，同应用壳登记变化时。
    f.workspace.release_readers();
    std::fs::rename(&root, f.dir.path().join("offline-adult")).unwrap();
    let offline = f
        .workspace
        .import_receipts(&mut f.device, &mut f.catalog, true)
        .unwrap();
    assert!(
        offline
            .iter()
            .find(|r| r.task_id == f.task)
            .unwrap()
            .report
            .as_ref()
            .unwrap()
            .sealed_duplicates
    );
    let session = f.open();
    let late = f.resolve(&session);
    f.device.unregister(&adult_id).unwrap();
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, late, true)
            .is_err()
    );
    assert!(
        f.workspace
            .open_import_preview(
                &mut f.device,
                &mut f.catalog,
                &f.target.info().id,
                &f.task,
                true
            )
            .is_err(),
        "no longer known Adult means no sealed preview capability"
    );
}

#[test]
fn deleted_and_permanently_deleted_content_never_revives_through_an_old_receipt() {
    let mut f = Fixture::new();
    let session = f.open();
    let late = f.resolve(&session);
    f.target
        .edit(std::slice::from_ref(&f.target_image), &[ImageEdit::Delete])
        .unwrap();
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, late, true)
            .is_err()
    );
    let deleted_at = f.target.image(&f.target_image).unwrap().deleted_at.unwrap();
    let trash_task = receipt(&mut f.device, &f.target.info().id, vec![f.same.clone()]);
    let report = f
        .workspace
        .import_receipts(&mut f.device, &mut f.catalog, true)
        .unwrap()
        .into_iter()
        .find(|r| r.task_id == trash_task)
        .unwrap()
        .report
        .unwrap();
    assert!(!report.sealed_duplicates && report.trash_duplicates);
    assert!(
        f.workspace
            .open_import_preview(
                &mut f.device,
                &mut f.catalog,
                &f.target.info().id,
                &trash_task,
                true
            )
            .is_err()
    );
    assert_eq!(
        f.target.image(&f.target_image).unwrap().deleted_at,
        Some(deleted_at)
    );
    let groups =
        kinshoko_core::reference_groups::ReferenceGroups::open(&f.dir.path().join("groups"))
            .unwrap();
    let ids = vec![f.target_image.clone()];
    let preview = f.target.preview_permanent_delete(&ids, &groups).unwrap();
    f.target
        .permanent_delete(&ids, &preview.token, &groups)
        .unwrap();
    assert!(
        f.workspace
            .open_import_preview(
                &mut f.device,
                &mut f.catalog,
                &f.target.info().id,
                &f.task,
                true
            )
            .is_err()
    );
    assert!(f.target.image(&f.target_image).is_err());
}

#[test]
fn report_dismissal_and_identity_replacement_reject_pending_content() {
    let mut f = Fixture::new();
    let session = f.open();
    let late = f.resolve(&session);
    f.device
        .dismiss_import(&f.target.info().id, &f.task)
        .unwrap();
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, late, true)
            .is_err()
    );
    assert!(
        f.workspace
            .open_import_preview(
                &mut f.device,
                &mut f.catalog,
                &f.target.info().id,
                &f.task,
                true
            )
            .is_err()
    );
    let task = receipt(&mut f.device, &f.target.info().id, vec![f.same.clone()]);
    let session = f
        .workspace
        .open_import_preview(
            &mut f.device,
            &mut f.catalog,
            &f.target.info().id,
            &task,
            true,
        )
        .unwrap();
    let late = f.resolve(&session);
    let root = f.adult.as_ref().unwrap().info().root.clone();
    drop(f.adult.take());
    // 长期只读句柄（#313）握着时 Windows 上改不了名：模拟断开前先放掉，同应用壳登记变化时。
    f.workspace.release_readers();
    std::fs::rename(&root, f.dir.path().join("old-adult")).unwrap();
    let replacement = Library::create(&root, "Different identity").unwrap();
    assert!(
        f.workspace
            .complete_import_preview(&mut f.device, &mut f.catalog, late, true)
            .is_err()
    );
    assert_ne!(
        replacement.info().id,
        f.device
            .libraries()
            .iter()
            .find(|r| r.root == root)
            .unwrap()
            .id
    );
}

#[test]
fn replacing_original_bytes_cannot_reuse_an_old_receipt_as_a_display_capability() {
    let mut f = Fixture::new();
    let session = f.open();
    let foreign = png(f.dir.path(), "foreign-original.png", 230);
    let original_path = f.target.original_path(&f.target_image).unwrap();
    std::fs::write(original_path, std::fs::read(foreign).unwrap()).unwrap();
    let request = f
        .workspace
        .prepare_import_preview(
            &mut f.device,
            &mut f.catalog,
            &session.id,
            &session.items[0],
            true,
            240,
        )
        .unwrap();
    assert!(
        request.resolve().is_err(),
        "receipt SHA must match real original bytes, not only its stale record"
    );
}
