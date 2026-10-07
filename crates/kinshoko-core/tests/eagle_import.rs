//! Eagle 首次迁入（#57）：只通过核心 crate 的公开接口验证，源库始终只读。

#[path = "support/eagle.rs"]
mod eagle;

use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, EagleDiscoveryMethod, EagleDiscoveryOptions, ImageEdit, LibraryEvent,
    TagEdit, TagNamespace, TagRef, discover_eagle_libraries,
};
use kinshoko_core::library::{ImportOutcome, ImportSource};
use sha2::{Digest, Sha256};

#[test]
fn first_import_reads_items_not_thumbnails_or_mtime_and_preserves_original_bytes() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 1);
        let original = std::fs::read(fixture.original(0)).unwrap();
        let metadata = std::fs::read(fixture.item_dir(0).join("metadata.json")).unwrap();
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();

        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();

        assert_eq!(report.items.len(), 1, "只枚举 images 下的条目：{report:?}");
        let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
            panic!("Eagle {version} 应成功迁入：{report:?}");
        };
        assert_eq!(
            Sha256::digest(std::fs::read(library.original_path(image_id).unwrap()).unwrap()),
            Sha256::digest(&original)
        );
        assert_eq!(std::fs::read(fixture.original(0)).unwrap(), original);
        assert_eq!(
            std::fs::read(fixture.item_dir(0).join("metadata.json")).unwrap(),
            metadata
        );
    }
}

#[test]
fn eagle_import_uses_decoded_display_dimensions_and_keeps_metadata_verbatim() {
    use image::ImageEncoder;

    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 2);
        fixture.items[0]["width"] = serde_json::json!(900);
        fixture.items[0]["height"] = serde_json::json!(300);
        fixture.save_item(0);

        // 原文件为 48 × 24，EXIF 方向 6 表示顺时针旋转 90°。
        fixture.items[1]["ext"] = serde_json::json!("jpg");
        fixture.items[1]["width"] = serde_json::json!(48);
        fixture.items[1]["height"] = serde_json::json!(24);
        let pixels = image::RgbImage::new(48, 24);
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut bytes);
        encoder
            .set_exif_metadata(vec![
                b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0,
                0,
            ])
            .unwrap();
        encoder
            .write_image(pixels.as_raw(), 48, 24, image::ExtendedColorType::Rgb8)
            .unwrap();
        std::fs::write(fixture.original(1), &bytes).unwrap();
        fixture.items[1]["size"] = serde_json::json!(bytes.len());
        fixture.save_item(1);

        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        assert!(
            report
                .items
                .iter()
                .all(|item| matches!(item.outcome, ImportOutcome::Imported { .. })),
            "{report:?}"
        );
        let sources = library.eagle_sources().unwrap();
        for (i, expected) in [(20, 20), (24, 48)].into_iter().enumerate() {
            let binding = &sources[0].bindings[i];
            let detail = library.image(&binding.image_id).unwrap();
            assert_eq!((detail.width, detail.height), expected);
            assert_eq!(
                binding.raw_item_json,
                std::fs::read_to_string(fixture.item_dir(i).join("metadata.json")).unwrap()
            );
        }
        let page = library
            .browse(&BrowseQuery {
                scope: BrowseScope::All,
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                thumbnail_px: 256,
            })
            .unwrap();
        for (i, expected) in [(20, 20), (24, 48)].into_iter().enumerate() {
            let card = page
                .cards
                .iter()
                .find(|card| card.id == sources[0].bindings[i].image_id)
                .unwrap();
            assert_eq!((card.width, card.height), expected);
        }
    }
}

#[test]
fn all_eagle_fields_folders_tags_notes_links_and_region_comments_survive_reopen() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 4);
        let root = dir.path().join("kinshoko");
        let library = Library::create(&root, "参考").unwrap();
        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        assert!(
            report
                .items
                .iter()
                .all(|item| matches!(item.outcome, ImportOutcome::Imported { .. })),
            "{report:?}"
        );
        let sources = library.eagle_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0].raw_library_json,
            std::fs::read_to_string(fixture.root.join("metadata.json")).unwrap()
        );
        assert_eq!(sources[0].bindings.len(), 4);
        for (i, binding) in sources[0].bindings.iter().enumerate() {
            assert_eq!(
                binding.external_id,
                fixture.items[i]["id"].as_str().unwrap()
            );
            assert_eq!(
                binding.raw_item_json,
                std::fs::read_to_string(fixture.item_dir(i).join("metadata.json")).unwrap()
            );
            let detail = library.image(&binding.image_id).unwrap();
            assert_eq!(detail.original_name, format!("图{i:04}"));
            assert_eq!(detail.collected_at, 1756571097667_i64 + i as i64);
            assert_eq!(detail.source_links, [format!("https://example.com/{i}")]);
            assert_eq!(detail.note.sources[0].text, format!("看高光{i}"));
            assert_eq!(
                detail
                    .folders
                    .iter()
                    .map(|f| f.name.as_str())
                    .collect::<Vec<_>>(),
                if i % 3 == 2 {
                    vec![]
                } else {
                    vec!["发型参考", "女"]
                }
            );
            let mut names: Vec<_> = library
                .image_tags(&binding.image_id, "zh-CN")
                .unwrap()
                .tags
                .into_iter()
                .map(|t| t.tag.name)
                .collect();
            names.sort();
            assert_eq!(names, [format!("标签{i}"), "蓝发".to_owned()]);
            if i == 3 {
                assert_eq!(binding.region_notes[0].basis, "eagle-raw-unverified");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&binding.region_notes[0].raw_json)
                        .unwrap(),
                    fixture.items[i]["comments"][0]
                );
            }
        }
        let sidebar = library.sidebar().unwrap();
        assert_eq!(
            sidebar
                .folders
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["角色", "发型参考", "空文件夹"]
        );
        assert_eq!(sidebar.folders[0].children[0].name, "女");
        drop(library);
        let reopened = Library::open(&root).unwrap();
        assert_eq!(reopened.eagle_sources().unwrap(), sources);
    }
}

#[test]
fn discovery_finds_settings_history_and_counts_the_images_directory() {
    let dir = tempfile::tempdir().unwrap();
    let large = eagle::build(&dir.path().join("主库.library"), "1.8.2", 150);
    let small = eagle::build(&dir.path().join("第二个库.library"), "4.0.0", 20);
    let app_data = dir.path().join("appdata");
    std::fs::create_dir_all(app_data.join("Eagle")).unwrap();
    eagle::write_json(
        &app_data.join("Eagle/Settings"),
        &serde_json::json!({
            "libraryHistory": [small.root, large.root, large.root, dir.path().join("不存在.library")]
        }),
    );

    let found = discover_eagle_libraries(&EagleDiscoveryOptions {
        app_data,
        api_address: None,
        scan_roots: Vec::new(),
        ..Default::default()
    });

    assert_eq!(found.len(), 2);
    assert_eq!(found[0].name, "主库");
    assert_eq!(found[0].items, 150);
    assert_eq!(found[0].version.as_deref(), Some("1.8.2"));
    assert_eq!(found[1].items, 20);
    assert_eq!(found[1].version.as_deref(), Some("4.0.0"));
}

fn count(library: &Library, scope: BrowseScope) -> u32 {
    library
        .browse(&BrowseQuery {
            scope,
            conditions: Default::default(),
            cursor: None,
            limit: 1,
            thumbnail_px: 256,
        })
        .unwrap()
        .total
}

#[test]
fn active_eagle_duplicates_stay_visible_regardless_of_order_or_retry() {
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
                    )),
                    "{report:?}"
                );
                assert_eq!(count(&library, BrowseScope::All), 1);
                assert_eq!(count(&library, BrowseScope::Trash), 0);
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
                    library.image(&bindings[0].image_id).unwrap().deleted_at,
                    None
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
                ImportOutcome::Merged {
                    image_id: image_id.clone()
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

#[test]
fn partial_failures_retry_as_eagle_items_and_keep_successes_and_manual_decisions() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 6);
    let good = fixture.items.clone();
    fixture.items[1]["size"] = serde_json::json!(1);
    fixture.items[2].as_object_mut().unwrap().remove("width");
    fixture.save_item(1);
    fixture.save_item(2);
    std::fs::write(fixture.item_dir(3).join("metadata.json"), b"broken json").unwrap();
    fixture.items[4]["name"] = serde_json::json!("../outside");
    fixture.save_item(4);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let report = library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    assert_eq!(
        report
            .items
            .iter()
            .filter(|i| matches!(i.outcome, ImportOutcome::ReadFailed { .. }))
            .count(),
        4,
        "{report:?}"
    );
    assert!(
        matches!(&report.items[1].outcome, ImportOutcome::ReadFailed { reason } if reason.contains("size"))
    );
    assert!(
        matches!(&report.items[2].outcome, ImportOutcome::ReadFailed { reason } if reason.contains("width"))
    );
    assert_eq!(library.eagle_sources().unwrap()[0].bindings.len(), 2);
    let id = library.eagle_sources().unwrap()[0].bindings[0]
        .image_id
        .clone();
    let trash = library.eagle_sources().unwrap()[0].bindings[1]
        .image_id
        .clone();
    assert_eq!(
        library.image(&trash).unwrap().deleted_at,
        Some(1756571200005)
    );
    library
        .edit(std::slice::from_ref(&trash), &[ImageEdit::Restore])
        .unwrap();
    library
        .edit(
            std::slice::from_ref(&id),
            &[
                ImageEdit::SetNote {
                    text: "画师自己的备注".into(),
                },
                ImageEdit::Delete,
            ],
        )
        .unwrap();
    library
        .edit_tags(
            std::slice::from_ref(&id),
            &[TagEdit::Reject {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "蓝发".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let again = library.import(report.retry_source().unwrap()).wait();
    assert_eq!(again.items.len(), 4);
    assert!(
        again
            .items
            .iter()
            .all(|i| matches!(i.outcome, ImportOutcome::ReadFailed { .. }))
    );
    assert_eq!(library.eagle_sources().unwrap()[0].bindings.len(), 2);
    fixture.items = good;
    for i in 1..=4 {
        fixture.save_item(i);
    }
    let retry = library.import(again.retry_source().unwrap()).wait();
    assert!(
        retry
            .items
            .iter()
            .all(|i| matches!(i.outcome, ImportOutcome::Imported { .. })),
        "{retry:?}"
    );
    let before = library.eagle_sources().unwrap();
    let repeat = library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    assert!(
        repeat
            .items
            .iter()
            .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
        "{repeat:?}"
    );
    assert_eq!(library.eagle_sources().unwrap(), before);
    assert_eq!(count(&library, BrowseScope::All), 5);
    assert_eq!(count(&library, BrowseScope::Trash), 1);
    assert_eq!(
        library.image(&id).unwrap().note.manual.as_deref(),
        Some("画师自己的备注")
    );
    assert_eq!(
        library.image(&trash).unwrap().deleted_at,
        None,
        "重试不能重新删除已恢复的图"
    );
    assert!(
        library
            .image_tags(&id, "zh-CN")
            .unwrap()
            .tags
            .iter()
            .all(|t| t.tag.name != "蓝发")
    );
}

#[test]
fn collection_time_falls_back_by_field_presence_and_unknown_versions_are_allowed() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = eagle::build(&dir.path().join("主库.library"), "99.未来版本", 3);
    fixture.items[1].as_object_mut().unwrap().remove("btime");
    fixture.items[2].as_object_mut().unwrap().remove("btime");
    fixture.items[2]
        .as_object_mut()
        .unwrap()
        .remove("modificationTime");
    fixture.save_item(1);
    fixture.save_item(2);
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let report = library
        .import(ImportSource {
            paths: vec![fixture.root],
        })
        .wait();
    assert!(
        report
            .items
            .iter()
            .all(|i| matches!(i.outcome, ImportOutcome::Imported { .. })),
        "{report:?}"
    );
    let bindings = &library.eagle_sources().unwrap()[0].bindings;
    assert_eq!(
        library.image(&bindings[0].image_id).unwrap().collected_at,
        1756571097667
    );
    assert_eq!(
        library.image(&bindings[1].image_id).unwrap().collected_at,
        1756571099668
    );
    assert!(library.image(&bindings[2].image_id).unwrap().collected_at >= before);
}

#[test]
fn discovery_uses_local_api_first_and_falls_back_to_a_bounded_disk_scan() {
    use std::io::{Read, Write};
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("素材/主库.library"), "4.0.0", 1);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = serde_json::json!({"status":"success", "data":[fixture.root]}).to_string();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 4096];
        let n = stream.read(&mut request).unwrap();
        assert!(
            std::str::from_utf8(&request[..n])
                .unwrap()
                .starts_with("GET /api/library/history ")
        );
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let mut options = EagleDiscoveryOptions {
        app_data: dir.path().join("不存在"),
        api_address: Some(address),
        scan_roots: vec![dir.path().to_path_buf()],
        ..Default::default()
    };
    let from_api = discover_eagle_libraries(&options);
    server.join().unwrap();
    assert_eq!(from_api.len(), 1);
    assert_eq!(from_api[0].found_by, EagleDiscoveryMethod::Api);
    eagle::build(&dir.path().join("Windows/跳过.library"), "4.0.0", 1);
    eagle::build(&dir.path().join("node_modules/跳过.library"), "4.0.0", 1);
    options.api_address = Some(address); // 服务已退出，必须继续走设置与磁盘回退。
    let scanned = discover_eagle_libraries(&options);
    assert_eq!(scanned.len(), 1);
    assert_eq!(scanned[0].name, "主库");
    assert_eq!(scanned[0].found_by, EagleDiscoveryMethod::Scan);
}

#[test]
fn imported_eagle_source_links_can_be_found_with_the_integrated_text_search() {
    use kinshoko_core::search::{ConditionInput, Search, SearchInput, TermInput};
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 1);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    library
        .import(ImportSource {
            paths: vec![fixture.root],
        })
        .wait();
    let conditions = Search::new(
        &library.vocabulary().unwrap(),
        &kinshoko_core::approx::BuiltinApproxTable::from_pairs(1, []),
    )
    .resolve(
        &SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::Text {
                    text: "example.com/0".into(),
                    dismissed: Vec::new(),
                }],
                negate: false,
            }],
            exact: false,
        },
        "zh-CN",
    );
    let page = library
        .browse(&BrowseQuery {
            scope: BrowseScope::All,
            conditions,
            cursor: None,
            limit: 10,
            thumbnail_px: 256,
        })
        .unwrap();
    assert_eq!(page.total, 1, "迁入的来源链接也属于可查找的参考图文字");
    assert_eq!(
        page.cards[0].id,
        library.eagle_sources().unwrap()[0].bindings[0].image_id
    );
}
