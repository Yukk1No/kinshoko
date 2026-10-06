//! Eagle 首次迁入（#57）：只通过核心 crate 的公开接口验证，源库始终只读。

#[path = "support/eagle.rs"]
mod eagle;

use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, EagleDiscoveryMethod, EagleDiscoveryOptions, ImageEdit, TagEdit,
    TagNamespace, TagRef, discover_eagle_libraries,
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
            .all(|i| matches!(i.outcome, ImportOutcome::Merged { .. })),
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
    let conditions = Search::new(&library.vocabulary().unwrap()).resolve(
        &SearchInput {
            conditions: vec![ConditionInput {
                any: vec![TermInput::Text {
                    text: "example.com/0".into(),
                }],
                negate: false,
            }],
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
