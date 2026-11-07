//! Eagle 导入：部分失败重试、收藏时间、发现与查找（接 `eagle_import.rs`）。

use super::*;

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
        matches!(&report.items[1].outcome, ImportOutcome::ReadFailed { reason } if reason.to_string().contains("size"))
    );
    assert!(
        matches!(&report.items[2].outcome, ImportOutcome::ReadFailed { reason } if reason.to_string().contains("width"))
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
            .enumerate()
            .all(|(index, i)| if index == 0 {
                matches!(i.outcome, ImportOutcome::TrashDuplicate { .. })
            } else {
                matches!(i.outcome, ImportOutcome::Refreshed { .. })
            }),
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
