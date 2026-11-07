//! Eagle 导入：重复条目与两个资料库（接 `eagle_import.rs`）。

use super::*;

#[test]
fn same_task_live_eagle_duplicates_set_initial_state_but_retries_preserve_existing_trash() {
    for version in ["1.8.2", "4.0.0"] {
        for trash_first in [true, false] {
            for retry_after_reopen in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 2);
                std::fs::copy(fixture.original(0), fixture.original(1)).unwrap();
                fixture.items[1]["size"] = fixture.items[0]["size"].clone();
                for i in 0..2 {
                    fixture.items[i]["isDeleted"] = serde_json::json!((i == 0) == trash_first);
                    fixture.save_item(i);
                }
                let root = dir.path().join("kinshoko");
                let mut library = Library::create(&root, "参考").unwrap();
                if retry_after_reopen {
                    let report = library
                        .import(ImportSource {
                            paths: vec![fixture.item_dir(0)],
                        })
                        .wait();
                    assert!(matches!(
                        report.items[0].outcome,
                        ImportOutcome::Imported { .. }
                    ));
                    drop(library);
                    library = Library::open(&root).unwrap();
                }
                let report = library
                    .import(ImportSource {
                        paths: vec![fixture.root.clone()],
                    })
                    .wait();
                assert!(
                    report.items.iter().all(|item| matches!(
                        item.outcome,
                        ImportOutcome::Imported { .. }
                            | ImportOutcome::Merged { .. }
                            | ImportOutcome::Refreshed { .. }
                            | ImportOutcome::TrashDuplicate { .. }
                    )),
                    "{report:?}"
                );
                // #78 T14：同一任务中新建图的初始状态与顺序无关；前一次任务的回收站不可自动恢复。
                let remains_in_trash = retry_after_reopen && trash_first;
                assert_eq!(
                    count(&library, BrowseScope::All),
                    u32::from(!remains_in_trash)
                );
                assert_eq!(
                    count(&library, BrowseScope::Trash),
                    u32::from(remains_in_trash)
                );
                let sources = library.eagle_sources().unwrap();
                let bindings = &sources[0].bindings;
                assert_eq!(bindings.len(), 2);
                assert_eq!(bindings[0].image_id, bindings[1].image_id);
                assert_eq!(
                    bindings
                        .iter()
                        .map(|binding| binding.state.as_str())
                        .collect::<Vec<_>>(),
                    if trash_first {
                        vec!["trashed", "present"]
                    } else {
                        vec!["present", "trashed"]
                    }
                );
                assert_eq!(
                    library
                        .image(&bindings[0].image_id)
                        .unwrap()
                        .deleted_at
                        .is_some(),
                    remains_in_trash
                );
            }
        }
    }
}

#[test]
fn new_eagle_duplicates_preserve_manual_deletion_and_restore() {
    for trash_first in [true, false] {
        for edit in [ImageEdit::Delete, ImageEdit::Restore] {
            let dir = tempfile::tempdir().unwrap();
            let mut fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 2);
            std::fs::copy(fixture.original(0), fixture.original(1)).unwrap();
            fixture.items[1]["size"] = fixture.items[0]["size"].clone();
            for i in 0..2 {
                fixture.items[i]["isDeleted"] = serde_json::json!((i == 0) == trash_first);
                fixture.save_item(i);
            }
            let root = dir.path().join("kinshoko");
            let library = Library::create(&root, "参考").unwrap();
            let first = library
                .import(ImportSource {
                    paths: vec![fixture.item_dir(0)],
                })
                .wait();
            let ImportOutcome::Imported { image_id } = &first.items[0].outcome else {
                panic!("{first:?}");
            };
            let deleted_at = library
                .edit(std::slice::from_ref(image_id), &[edit])
                .unwrap()[0]
                .deleted_at;
            drop(library);
            let library = Library::open(&root).unwrap();
            let second = library
                .import(ImportSource {
                    paths: vec![fixture.item_dir(1)],
                })
                .wait();
            assert_eq!(
                second.items[0].outcome,
                if deleted_at.is_some() {
                    ImportOutcome::TrashDuplicate {
                        image_id: image_id.clone(),
                    }
                } else {
                    ImportOutcome::Merged {
                        image_id: image_id.clone(),
                    }
                }
            );
            assert_eq!(library.image(image_id).unwrap().deleted_at, deleted_at);
        }
    }
}

#[test]
fn eagle_import_batches_list_refreshes_including_metadata_only_merges() {
    use std::time::Instant;

    for metadata_only in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 30);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        if metadata_only {
            for i in 1..fixture.items.len() {
                std::fs::copy(fixture.original(0), fixture.original(i)).unwrap();
                fixture.items[i]["size"] = fixture.items[0]["size"].clone();
                fixture.save_item(i);
            }
            let report = library
                .import(ImportSource {
                    paths: vec![fixture.original(0)],
                })
                .wait();
            assert!(matches!(
                report.items[0].outcome,
                ImportOutcome::Imported { .. }
            ));
        }
        // 来源文件夹登记会单独刷新一次；此处只观察后续条目的批量通知。
        library
            .import(ImportSource {
                paths: vec![fixture.item_dir(0)],
            })
            .wait();
        let events = library.events();
        let start = Instant::now();
        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        let elapsed = start.elapsed();
        assert!(
            report.items.iter().all(|item| matches!(
                item.outcome,
                ImportOutcome::Imported { .. }
                    | ImportOutcome::Merged { .. }
                    | ImportOutcome::Refreshed { .. }
            )),
            "{report:?}"
        );
        if metadata_only {
            assert!(report.items.iter().all(|item| matches!(
                item.outcome,
                ImportOutcome::Merged { .. } | ImportOutcome::Refreshed { .. }
            )));
        }
        let delivered: Vec<_> = events.try_iter().collect();
        let refreshes = delivered
            .iter()
            .filter(|event| matches!(event, LibraryEvent::ListStale { .. }))
            .count();
        assert!(refreshes > 0, "新增来源事实也应使浏览结果过期");
        // 每 500 ms 最多一次，另允许任务结束时发出最后一批；不要求机器在固定时限内完成。
        assert!(
            refreshes as u128 <= elapsed.as_millis() / 500 + 1,
            "{refreshes} 次刷新超过批量通知上限，耗时 {elapsed:?}"
        );
        assert!(matches!(
            delivered.last(),
            Some(LibraryEvent::TaskFinished { .. })
        ));
        let last_change = delivered
            .iter()
            .rposition(|event| matches!(event, LibraryEvent::ImagesChanged { .. }))
            .unwrap();
        assert!(
            delivered[last_change..]
                .iter()
                .any(|event| matches!(event, LibraryEvent::ListStale { .. })),
            "最后一批来源事实提交后也应通知重新浏览"
        );

        library
            .import(ImportSource {
                paths: vec![fixture.root],
            })
            .wait();
        assert!(
            events
                .try_iter()
                .all(|event| !matches!(event, LibraryEvent::ListStale { .. })),
            "重复提交已登记条目没有变更，不需要重新浏览"
        );
    }
}

#[test]
fn same_library_duplicates_keep_each_source_and_two_libraries_keep_independent_records() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let main = eagle::build(&dir.path().join("主库.library"), version, 150);
        let second = eagle::build(&dir.path().join("第二个库.library"), version, 20);
        let library = Library::create(&dir.path().join("main"), "主库").unwrap();
        let other = Library::create(&dir.path().join("second"), "第二个库").unwrap();
        let report = library
            .import(ImportSource {
                paths: vec![main.root.clone()],
            })
            .wait();
        assert_eq!(
            report
                .items
                .iter()
                .filter(|i| matches!(i.outcome, ImportOutcome::Imported { .. }))
                .count(),
            149
        );
        assert_eq!(
            report
                .items
                .iter()
                .filter(|i| matches!(i.outcome, ImportOutcome::Merged { .. }))
                .count(),
            1
        );
        assert_eq!(count(&library, BrowseScope::All), 145);
        assert_eq!(count(&library, BrowseScope::Trash), 4);
        let source = &library.eagle_sources().unwrap()[0];
        assert_eq!(source.bindings.len(), 150);
        let first = &source.bindings[7];
        let duplicate = &source.bindings[8];
        assert_eq!(first.image_id, duplicate.image_id);
        assert_ne!(first.raw_item_json, duplicate.raw_item_json);
        let detail = library.image(&first.image_id).unwrap();
        assert_eq!(detail.note.sources.len(), 2);
        assert_eq!(
            detail.source_links,
            ["https://example.com/7", "https://example.com/8"]
        );
        let mut names: Vec<_> = library
            .image_tags(&first.image_id, "zh-CN")
            .unwrap()
            .tags
            .into_iter()
            .map(|t| t.tag.name)
            .collect();
        names.sort();
        assert_eq!(names, ["标签7", "标签8", "蓝发"]);

        other
            .import(ImportSource {
                paths: vec![second.root.clone()],
            })
            .wait();
        let other_source = &other.eagle_sources().unwrap()[0];
        assert_ne!(library.info().id, other.info().id);
        assert_eq!(source.bindings[0].sha256, other_source.bindings[0].sha256);
        assert_ne!(
            source.bindings[0].image_id,
            other_source.bindings[0].image_id
        );
        assert_eq!(
            std::fs::read(library.original_path(&source.bindings[0].image_id).unwrap()).unwrap(),
            std::fs::read(
                other
                    .original_path(&other_source.bindings[0].image_id)
                    .unwrap()
            )
            .unwrap()
        );
        library
            .edit(
                &[source.bindings[0].image_id.clone()],
                &[ImageEdit::SetNote {
                    text: "本库备注".into(),
                }],
            )
            .unwrap();
        assert_eq!(
            other
                .image(&other_source.bindings[0].image_id)
                .unwrap()
                .note
                .manual,
            None
        );
    }
}
