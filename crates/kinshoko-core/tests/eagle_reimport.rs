//! Eagle 重导与按来源分层（#58）：#8 中“重导”与“搬家”两组检查改写为核心 crate 测试。
//! 只经公开接口观察，源库始终只读；1.8.x 与 4.x 各跑一遍。

#[path = "support/eagle.rs"]
mod eagle;

use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, EagleLocationChoice, Error, FolderNode, ImageEdit, ImportOutcome,
    ImportReport, ImportSource, TagEdit, TagNamespace, TagRef,
};
use serde_json::json;

const VERSIONS: [&str; 2] = ["1.8.2", "4.0.0"];

fn import(library: &Library, path: &Path) -> ImportReport {
    library
        .import(ImportSource {
            paths: vec![path.to_path_buf()],
        })
        .wait()
}

fn tag(name: &str) -> TagRef {
    TagRef::Named {
        namespace: TagNamespace::General,
        name: name.into(),
        lang: "zh-CN".into(),
    }
}

fn tag_names(library: &Library, image_id: &str) -> Vec<String> {
    let mut names: Vec<_> = library
        .image_tags(image_id, "zh-CN")
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.tag.name)
        .collect();
    names.sort();
    names
}

fn folder_names(library: &Library, image_id: &str) -> Vec<String> {
    library
        .image(image_id)
        .unwrap()
        .folders
        .into_iter()
        .map(|f| f.name)
        .collect()
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

/// 首次迁入；返回各条目对应的参考图 id（按条目顺序）。
fn first_import(library: &Library, fixture: &eagle::EagleFixture) -> Vec<String> {
    let report = import(library, &fixture.root);
    assert!(
        report.items.iter().all(|i| matches!(
            i.outcome,
            ImportOutcome::Imported { .. } | ImportOutcome::Merged { .. }
        )),
        "{report:?}"
    );
    let source = &library.eagle_sources().unwrap()[0];
    fixture
        .items
        .iter()
        .map(|item| {
            source
                .bindings
                .iter()
                .find(|b| b.external_id == item["id"].as_str().unwrap())
                .unwrap()
                .image_id
                .clone()
        })
        .collect()
}

#[test]
fn reimport_refreshes_eagle_tags_and_notes_and_keeps_manual_curation() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 3);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let ids = first_import(&library, &fixture);

        // 画师在本库的整理：0 号否决“蓝发”、添加“短发”、改写备注；1 号不动。
        library
            .edit_tags(
                std::slice::from_ref(&ids[0]),
                &[
                    TagEdit::Reject { tag: tag("蓝发") },
                    TagEdit::Add { tag: tag("短发") },
                ],
            )
            .unwrap();
        library
            .edit(
                std::slice::from_ref(&ids[0]),
                &[ImageEdit::SetNote {
                    text: "画师的备注".into(),
                }],
            )
            .unwrap();

        // 画师在 Eagle 里继续整理：换标签、改备注、改链接。
        for i in 0..2 {
            fixture.items[i]["tags"] = json!(["蓝发", "新标签"]);
            fixture.items[i]["annotation"] = json!(format!("新备注{i}"));
            fixture.items[i]["url"] = json!(format!("https://example.com/new/{i}"));
            fixture.save_item(i);
        }
        let report = import(&library, &fixture.root);
        assert!(
            report
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
            "已迁入的条目只刷新，不新建记录：{report:?}"
        );
        assert_eq!(library.eagle_sources().unwrap()[0].bindings.len(), 3);
        assert_eq!(count(&library, BrowseScope::All), 3);

        // 人工决定保留，Eagle 新标签进入，Eagle 去掉的“标签0”随来源层消失。
        assert_eq!(tag_names(&library, &ids[0]), ["新标签", "短发"]);
        assert_eq!(tag_names(&library, &ids[1]), ["新标签", "蓝发"]);
        assert_eq!(tag_names(&library, &ids[2]), ["标签2", "蓝发"]);

        let detail = library.image(&ids[0]).unwrap();
        assert_eq!(detail.note.manual.as_deref(), Some("画师的备注"));
        assert_eq!(detail.note.sources[0].text, "新备注0");
        assert_eq!(detail.source_links, ["https://example.com/new/0"]);
        let detail = library.image(&ids[1]).unwrap();
        assert_eq!(detail.note.manual, None);
        assert_eq!(detail.note.sources.len(), 1);
        assert_eq!(detail.note.sources[0].text, "新备注1");

        let binding = &library.eagle_sources().unwrap()[0].bindings[1];
        assert_eq!(
            binding.raw_item_json,
            std::fs::read_to_string(fixture.item_dir(1).join("metadata.json")).unwrap(),
            "原样 JSON 随重导刷新"
        );
    }
}

fn binding_state(library: &Library, external_id: &str) -> String {
    library.eagle_sources().unwrap()[0]
        .bindings
        .iter()
        .find(|b| b.external_id == external_id)
        .unwrap()
        .state
        .clone()
}

#[test]
fn eagle_deletion_and_trash_never_reach_the_local_copy() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 3);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let ids = first_import(&library, &fixture);

        // Eagle 里彻底删掉 0 号、把 1 号移进回收站。
        std::fs::remove_dir_all(fixture.item_dir(0)).unwrap();
        fixture.items[1]["isDeleted"] = json!(true);
        fixture.save_item(1);
        let report = import(&library, &fixture.root);
        assert_eq!(report.items.len(), 2, "{report:?}");
        assert_eq!(report.eagle_missing, 1, "报告 Eagle 中已不存在的条目");

        assert_eq!(binding_state(&library, "ITEM000000000"), "missing");
        assert_eq!(binding_state(&library, "ITEM000000001"), "trashed");
        assert_eq!(count(&library, BrowseScope::All), 3, "本库副本都保留");
        assert_eq!(count(&library, BrowseScope::Trash), 0);
        let detail = library.image(&ids[0]).unwrap();
        assert_eq!(detail.deleted_at, None);
        assert_eq!(tag_names(&library, &ids[0]), ["标签0", "蓝发"]);
        assert!(library.original_path(&ids[0]).unwrap().is_file());

        // 画师在本库把 2 号删掉，Eagle 里仍是正常条目：重导不把它放回来。
        library
            .edit(std::slice::from_ref(&ids[2]), &[ImageEdit::Delete])
            .unwrap();
        // Eagle 里把 1 号移出回收站、0 号恢复（重新出现）。
        fixture.items[1]["isDeleted"] = json!(false);
        fixture.save_item(1);
        std::fs::create_dir_all(fixture.item_dir(0)).unwrap();
        let rebuilt = eagle::build(&dir.path().join("重建.library"), version, 1);
        std::fs::copy(rebuilt.original(0), fixture.original(0)).unwrap();
        fixture.save_item(0);
        let report = import(&library, &fixture.root);
        assert_eq!(report.eagle_missing, 0);
        assert!(
            report
                .items
                .iter()
                .enumerate()
                .all(|(index, i)| if index == 2 {
                    matches!(i.outcome, ImportOutcome::TrashDuplicate { .. })
                } else {
                    matches!(i.outcome, ImportOutcome::Refreshed { .. })
                }),
            "{report:?}"
        );
        assert_eq!(binding_state(&library, "ITEM000000000"), "present");
        assert_eq!(binding_state(&library, "ITEM000000001"), "present");
        assert_eq!(count(&library, BrowseScope::All), 2);
        assert_eq!(count(&library, BrowseScope::Trash), 1);
        assert!(library.image(&ids[2]).unwrap().deleted_at.is_some());
    }
}

#[test]
fn eagle_trash_counts_only_on_first_import() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 1);
        fixture.items[0]["isDeleted"] = json!(true);
        fixture.save_item(0);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let ids = first_import(&library, &fixture);
        assert!(library.image(&ids[0]).unwrap().deleted_at.is_some());

        // 之后 Eagle 把它移出回收站：本库状态不变，只改绑定。
        fixture.items[0]["isDeleted"] = json!(false);
        fixture.save_item(0);
        import(&library, &fixture.root);
        assert_eq!(binding_state(&library, "ITEM000000000"), "present");
        assert!(library.image(&ids[0]).unwrap().deleted_at.is_some());
    }
}

/// 换掉 Eagle 条目的原图字节（尺寸也变），并更新 metadata.json 的 size/宽高。
fn replace_original(fixture: &mut eagle::EagleFixture, index: usize, seed: u8) {
    let (width, height) = (31, 13);
    image::RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba([seed, y as u8, x as u8, 255])
    })
    .save(fixture.original(index))
    .unwrap();
    fixture.items[index]["size"] = json!(std::fs::metadata(fixture.original(index)).unwrap().len());
    fixture.items[index]["width"] = json!(width);
    fixture.items[index]["height"] = json!(height);
    fixture.save_item(index);
}

#[test]
fn changed_content_keeps_both_versions_and_they_can_be_told_apart() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 2);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let ids = first_import(&library, &fixture);
        let old_bytes = std::fs::read(library.original_path(&ids[0]).unwrap()).unwrap();
        library
            .edit(
                std::slice::from_ref(&ids[0]),
                &[ImageEdit::SetNote {
                    text: "旧版的备注".into(),
                }],
            )
            .unwrap();

        replace_original(&mut fixture, 0, 99);
        fixture.items[0]["tags"] = json!(["换图后"]);
        fixture.save_item(0);
        let report = import(&library, &fixture.root);
        let ImportOutcome::NewVersion {
            image_id: new_id,
            previous_image_id,
        } = &report.items[0].outcome
        else {
            panic!("内容变化应得到新版本：{report:?}");
        };
        assert_eq!(previous_image_id, &ids[0]);
        assert_ne!(new_id, &ids[0]);
        assert!(matches!(
            report.items[1].outcome,
            ImportOutcome::Refreshed { .. }
        ));

        // 两个版本都在，原图各自原样保存。
        assert_eq!(count(&library, BrowseScope::All), 3);
        assert_eq!(
            std::fs::read(library.original_path(&ids[0]).unwrap()).unwrap(),
            old_bytes
        );
        assert_eq!(
            std::fs::read(library.original_path(new_id).unwrap()).unwrap(),
            std::fs::read(fixture.original(0)).unwrap()
        );

        // 可区分：详情互相指明新旧；旧版保留它当时的整理与 Eagle 信息。
        let old = library.image(&ids[0]).unwrap();
        let new = library.image(new_id).unwrap();
        assert_eq!(old.versions.previous, None);
        assert_eq!(old.versions.newer, std::slice::from_ref(new_id));
        assert_eq!(new.versions.previous.as_deref(), Some(ids[0].as_str()));
        assert!(new.versions.newer.is_empty());
        assert_eq!(old.note.manual.as_deref(), Some("旧版的备注"));
        assert_eq!(new.note.manual, None);
        assert_eq!((new.width, new.height), (31, 13));
        assert_eq!(tag_names(&library, &ids[0]), ["标签0", "蓝发"]);
        assert_eq!(tag_names(&library, new_id), ["换图后"]);

        // 绑定：旧内容 superseded，新内容 present；再次重导不再新建。
        let source = &library.eagle_sources().unwrap()[0];
        let states: Vec<_> = source
            .bindings
            .iter()
            .filter(|b| b.external_id == "ITEM000000000")
            .map(|b| (b.image_id.clone(), b.state.clone()))
            .collect();
        assert_eq!(states.len(), 2);
        assert!(states.contains(&(ids[0].clone(), "superseded".into())));
        assert!(states.contains(&(new_id.clone(), "present".into())));
        let again = import(&library, &fixture.root);
        assert!(
            again
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
            "{again:?}"
        );
        assert_eq!(count(&library, BrowseScope::All), 3);
    }
}

fn folder_id(library: &Library, name: &str) -> String {
    fn find(nodes: &[FolderNode], name: &str) -> Option<String> {
        nodes.iter().find_map(|n| {
            (n.name == name)
                .then(|| n.id.clone())
                .or_else(|| find(&n.children, name))
        })
    }
    find(&library.sidebar().unwrap().folders, name).unwrap_or_else(|| panic!("没有文件夹 {name}"))
}

fn folder_paths(library: &Library) -> Vec<String> {
    fn walk(nodes: &[FolderNode], prefix: &str, out: &mut Vec<String>) {
        for n in nodes {
            let path = format!("{prefix}{}", n.name);
            out.push(path.clone());
            walk(&n.children, &format!("{path}/"), out);
        }
    }
    let mut out = Vec::new();
    walk(&library.sidebar().unwrap().folders, "", &mut out);
    out.sort();
    out
}

#[test]
fn reimport_applies_eagle_folder_changes_and_keeps_local_folder_adjustments() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 3);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let ids = first_import(&library, &fixture);
        assert_eq!(folder_names(&library, &ids[0]), ["发型参考", "女"]);

        // 画师在本库：把 0 号移出“发型参考”，把 1 号放进自己的文件夹，把“女”改名。
        let mine = library.create_folder("我的", None).unwrap();
        let hair = folder_id(&library, "发型参考");
        let girl = folder_id(&library, "女");
        library
            .edit(
                std::slice::from_ref(&ids[0]),
                &[ImageEdit::RemoveFromFolder { folder_id: hair }],
            )
            .unwrap();
        library
            .edit(
                std::slice::from_ref(&ids[1]),
                &[ImageEdit::AddToFolder { folder_id: mine }],
            )
            .unwrap();
        library.rename_folder(&girl, "女孩").unwrap();

        // 画师在 Eagle：改两个文件夹名、在“角色”下新建文件夹，并调整条目归属。
        let mut meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.root.join("metadata.json")).unwrap(),
        )
        .unwrap();
        meta["folders"][0]["children"][0]["name"] = json!("少女");
        meta["folders"][0]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "NEW", "name": "新文件夹", "children": []}));
        meta["folders"][1]["name"] = json!("发型");
        eagle::write_json(&fixture.root.join("metadata.json"), &meta);
        fixture.items[0]["folders"] = json!(["GIRL", "HAIR", "NEW"]);
        fixture.items[1]["folders"] = json!(["GIRL"]);
        fixture.items[2]["folders"] = json!(["NEW"]);
        for i in 0..3 {
            fixture.save_item(i);
        }
        let report = import(&library, &fixture.root);
        assert!(
            report
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
            "{report:?}"
        );

        // 画师改过的名字不被 Eagle 覆盖；没改过的跟随 Eagle；新文件夹只建一次。
        assert_eq!(
            folder_paths(&library),
            [
                "发型",
                "我的",
                "空文件夹",
                "角色",
                "角色/女孩",
                "角色/新文件夹"
            ]
        );
        // 画师移出的不放回；Eagle 新放入的进入；Eagle 移出的跟着移出；画师放入的保留。
        assert_eq!(folder_names(&library, &ids[0]), ["女孩", "新文件夹"]);
        assert_eq!(folder_names(&library, &ids[1]), ["女孩", "我的"]);
        assert_eq!(folder_names(&library, &ids[2]), ["新文件夹"]);

        // 再导一次不再变化。
        import(&library, &fixture.root);
        assert_eq!(folder_paths(&library).len(), 6);
        assert_eq!(folder_names(&library, &ids[0]), ["女孩", "新文件夹"]);
    }
}

/// Eagle 里把条目 `index` 放进或移出 HAIR，然后重导。
fn eagle_sets_hair(library: &Library, fixture: &mut eagle::EagleFixture, index: usize, on: bool) {
    fixture.items[index]["folders"] = if on {
        json!(["GIRL", "HAIR"])
    } else {
        json!(["GIRL"])
    };
    fixture.save_item(index);
    let report = import(library, &fixture.root);
    assert!(
        report
            .items
            .iter()
            .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
        "{report:?}"
    );
}

fn in_folder(library: &Library, image_id: &str, folder_id: &str) -> bool {
    library
        .image(image_id)
        .unwrap()
        .folders
        .iter()
        .any(|f| f.id == folder_id)
}

/// 画师在本库对一张图作出的文件夹决定，经 Eagle 反复同向、反向改动与重开都保留；
/// 画师没碰过的图继续跟随 Eagle。
fn manual_folder_decision_survives_eagle(manual_in: bool) {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 3);
        // 0 号是画师要决定的图；1 号是对照，画师不碰。两张起初都与画师的决定相反。
        for i in 0..2 {
            fixture.items[i]["folders"] = if manual_in {
                json!(["GIRL"])
            } else {
                json!(["GIRL", "HAIR"])
            };
            fixture.save_item(i);
        }
        let root = dir.path().join("kinshoko");
        let mut library = Library::create(&root, "参考").unwrap();
        let ids = first_import(&library, &fixture);
        let hair = folder_id(&library, "发型参考");
        let edit = if manual_in {
            ImageEdit::AddToFolder {
                folder_id: hair.clone(),
            }
        } else {
            ImageEdit::RemoveFromFolder {
                folder_id: hair.clone(),
            }
        };
        library
            .edit(std::slice::from_ref(&ids[0]), &[edit])
            .unwrap();
        assert_eq!(in_folder(&library, &ids[0], &hair), manual_in);

        for round in 0..2 {
            // Eagle 先与画师同向，再反向；中途关闭重开一次。
            for eagle_in in [manual_in, !manual_in] {
                eagle_sets_hair(&library, &mut fixture, 0, eagle_in);
                eagle_sets_hair(&library, &mut fixture, 1, eagle_in);
                assert_eq!(
                    in_folder(&library, &ids[0], &hair),
                    manual_in,
                    "{version} 第 {round} 轮 Eagle {eagle_in}：画师的决定被覆盖"
                );
                assert_eq!(
                    in_folder(&library, &ids[1], &hair),
                    eagle_in,
                    "{version} 第 {round} 轮：画师没决定的归属应跟随 Eagle"
                );
            }
            drop(library);
            library = Library::open(&root).unwrap();
            assert_eq!(in_folder(&library, &ids[0], &hair), manual_in);
        }
    }
}

#[test]
fn manual_folder_removal_survives_eagle_remove_then_add() {
    manual_folder_decision_survives_eagle(false);
}

#[test]
fn manual_folder_addition_survives_eagle_add_then_remove() {
    manual_folder_decision_survives_eagle(true);
}

/// 升级前的库（没有文件夹决定记录）打开后保留原有归属，之后的人工决定照样生效。
#[test]
fn a_library_from_before_folder_decisions_upgrades_and_keeps_its_folders() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 2);
    let root = dir.path().join("kinshoko");
    let library = Library::create(&root, "参考").unwrap();
    let ids = first_import(&library, &fixture);
    let hair = folder_id(&library, "发型参考");
    drop(library);
    {
        // 退回 folder_decision 之前的结构。按迁移名确定历史版本，不受后续追加数量影响。
        let conn = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
        let version = include_str!("../src/library/store.rs")
            .lines()
            .filter_map(|line| {
                line.split_once("include_str!(\"migrations/")
                    .map(|(_, name)| name)
            })
            .position(|name| name.starts_with("0077_folder_decision.sql\""))
            .expect("folder_decision 迁移必须存在");
        let triggers: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'list_revision_%'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for name in triggers {
            conn.execute_batch(&format!("DROP TRIGGER {name};"))
                .unwrap();
        }
        conn.execute_batch(&format!(
            "DROP TABLE eagle_deleted_content;
             DROP TABLE package_import;
             DROP TABLE restore_provenance;
             DROP TABLE original_removal;
             DROP TRIGGER trash_revision_insert;
             DROP TRIGGER trash_revision_update;
             DROP TRIGGER trash_revision_delete;
             DROP TABLE trash_revision;
             DROP TABLE folder_decision;
             DROP TABLE list_revision;
             PRAGMA user_version = {};",
            version
        ))
        .unwrap();
    }

    let library = Library::open(&root).unwrap();
    assert!(in_folder(&library, &ids[0], &hair) && in_folder(&library, &ids[1], &hair));
    library
        .edit(
            std::slice::from_ref(&ids[0]),
            &[ImageEdit::RemoveFromFolder {
                folder_id: hair.clone(),
            }],
        )
        .unwrap();
    eagle_sets_hair(&library, &mut fixture, 0, false);
    eagle_sets_hair(&library, &mut fixture, 0, true);
    assert!(!in_folder(&library, &ids[0], &hair));
    assert!(in_folder(&library, &ids[1], &hair));
}

#[test]
fn manual_folder_decision_stays_with_its_own_source() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut a = eagle::build(&dir.path().join("甲.library"), version, 1);
        let mut b = eagle::build(&dir.path().join("乙.library"), version, 1);
        let mut meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(b.root.join("metadata.json")).unwrap())
                .unwrap();
        meta["folders"][1]["name"] = json!("乙的发型");
        eagle::write_json(&b.root.join("metadata.json"), &meta);
        // 乙的条目 id 不同，避免被当成甲搬了家；原图相同，合并为同一张参考图。
        b.items[0]["id"] = json!("OTHER0000000");
        std::fs::rename(
            b.root.join("images/ITEM000000000.info"),
            b.root.join("images/OTHER0000000.info"),
        )
        .unwrap();
        b.save_item(0);

        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let id = first_import(&library, &a)[0].clone();
        let report = import(&library, &b.root);
        assert!(
            matches!(report.items[0].outcome, ImportOutcome::Merged { .. }),
            "{report:?}"
        );
        let (hair_a, hair_b) = (
            folder_id(&library, "发型参考"),
            folder_id(&library, "乙的发型"),
        );
        assert!(in_folder(&library, &id, &hair_a) && in_folder(&library, &id, &hair_b));

        // 画师只把它移出甲的文件夹；乙的文件夹归属照常跟随乙的 Eagle。
        library
            .edit(
                std::slice::from_ref(&id),
                &[ImageEdit::RemoveFromFolder {
                    folder_id: hair_a.clone(),
                }],
            )
            .unwrap();
        eagle_sets_hair(&library, &mut a, 0, false);
        eagle_sets_hair(&library, &mut a, 0, true);
        eagle_sets_hair(&library, &mut b, 0, false);
        assert!(!in_folder(&library, &id, &hair_a));
        assert!(!in_folder(&library, &id, &hair_b));
        eagle_sets_hair(&library, &mut b, 0, true);
        assert!(!in_folder(&library, &id, &hair_a));
        assert!(in_folder(&library, &id, &hair_b));
    }
}

/// 把整个 Eagle 资料库挪到新位置（源库本身的内容不变）。
fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
fn moved_eagle_library_is_only_proposed_until_the_artist_confirms_it() {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 4);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let ids = first_import(&library, &fixture);
        library
            .edit_tags(
                std::slice::from_ref(&ids[0]),
                &[TagEdit::Add { tag: tag("短发") }],
            )
            .unwrap();
        let before = library.eagle_sources().unwrap();
        let folders = folder_paths(&library);

        // 搬家：新位置的条目全是已登记来源的。
        let moved = dir.path().join("搬家后.library");
        std::fs::rename(&fixture.root, &moved).unwrap();
        let report = import(&library, &moved);
        assert!(report.items.is_empty(), "确认前不导入任何条目：{report:?}");
        assert_eq!(report.eagle_relocations.len(), 1, "{report:?}");
        let proposal = &report.eagle_relocations[0];
        assert_eq!(proposal.source_id, before[0].id);
        assert_eq!(proposal.from, before[0].location);
        assert_eq!(proposal.overlap_percent, 100);
        assert_eq!(library.eagle_sources().unwrap(), before, "确认前什么都不写");
        assert_eq!(folder_paths(&library), folders);

        // 确认是同一来源搬了家：沿用登记，重导只刷新。
        library
            .confirm_eagle_location(
                &moved,
                EagleLocationChoice::Moved {
                    source_id: proposal.source_id.clone(),
                },
            )
            .unwrap();
        let report = import(&library, &moved);
        assert!(report.eagle_relocations.is_empty());
        assert!(
            report
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
            "{report:?}"
        );
        let sources = library.eagle_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, before[0].id);
        assert_eq!(sources[0].location, std::fs::canonicalize(&moved).unwrap());
        assert_eq!(sources[0].bindings.len(), 4);
        assert_eq!(count(&library, BrowseScope::All), 4);
        assert_eq!(folder_paths(&library), folders, "文件夹不重复建");
        assert_eq!(tag_names(&library, &ids[0]), ["标签0", "短发", "蓝发"]);
        let eagle_rows: Vec<_> = library
            .image_sources(&ids[0])
            .unwrap()
            .into_iter()
            .filter(|s| s.source == "eagle")
            .collect();
        assert_eq!(eagle_rows.len(), 1, "来源记录跟着搬家：{eagle_rows:?}");
        // 按物理位置比较：TEMP 可能是短名或另一种大小写写法。
        assert!(real(&eagle_rows[0].location).starts_with(real(&moved)));
        assert_eq!(library.image(&ids[0]).unwrap().note.sources.len(), 1);

        // 另一份副本：确认是另一个来源，相同原图合并进已有记录。
        let copy = dir.path().join("副本.library");
        copy_dir(&moved, &copy);
        let report = import(&library, &copy);
        assert_eq!(report.eagle_relocations.len(), 1);
        assert!(report.items.is_empty());
        library
            .confirm_eagle_location(&copy, EagleLocationChoice::Separate)
            .unwrap();
        let report = import(&library, &copy);
        assert!(
            report
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Merged { .. })),
            "{report:?}"
        );
        let sources = library.eagle_sources().unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(count(&library, BrowseScope::All), 4);
        assert_eq!(tag_names(&library, &ids[0]), ["标签0", "短发", "蓝发"]);

        // 再导副本：已登记，不再提议。
        let again = import(&library, &copy);
        assert!(again.eagle_relocations.is_empty());
        assert_eq!(library.eagle_sources().unwrap().len(), 2);
    }
}

/// 同一物理位置的规范写法，用来比较路径而不受写法（大小写、短名）影响。
fn real(path: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|e| panic!("{path:?} 不存在：{e}"))
}

/// 这张图的 Eagle 来源记录：每条都必须指向新位置下真实存在的原图。
fn assert_eagle_rows_at(library: &Library, image_id: &str, root: &Path) {
    let rows: Vec<_> = library
        .image_sources(image_id)
        .unwrap()
        .into_iter()
        .filter(|s| s.source == "eagle")
        .collect();
    assert_eq!(rows.len(), 1, "同一来源只有一行记录：{rows:?}");
    assert!(
        rows[0].location.exists(),
        "来源地址指向不存在的位置：{rows:?}"
    );
    assert!(
        real(&rows[0].location).starts_with(real(root)),
        "来源地址没有跟着搬家：{rows:?}"
    );
}

/// 首次迁入用 `spelling` 这种写法，搬家后确认、重导、改备注、重开，来源层都只有一份且指向新位置。
fn relocation_moves_every_source_row(spelling: impl Fn(&Path) -> std::path::PathBuf) {
    for version in VERSIONS {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("Case-Source.library"), version, 2);
        let root = dir.path().join("kinshoko");
        let library = Library::create(&root, "参考").unwrap();
        let report = import(&library, &spelling(&fixture.root));
        assert!(
            report
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Imported { .. })),
            "{report:?}"
        );
        let id = library.eagle_sources().unwrap()[0]
            .bindings
            .iter()
            .find(|b| b.external_id == "ITEM000000000")
            .unwrap()
            .image_id
            .clone();

        let moved = dir.path().join("Moved.library");
        std::fs::rename(&fixture.root, &moved).unwrap();
        fixture.root = moved.clone();
        let report = import(&library, &spelling(&moved));
        let proposal = &report.eagle_relocations[0];
        library
            .confirm_eagle_location(
                &spelling(&moved),
                EagleLocationChoice::Moved {
                    source_id: proposal.source_id.clone(),
                },
            )
            .unwrap();
        let report = import(&library, &moved);
        assert!(
            report
                .items
                .iter()
                .all(|i| matches!(i.outcome, ImportOutcome::Refreshed { .. })),
            "{report:?}"
        );
        assert_eagle_rows_at(&library, &id, &moved);

        // Eagle 里改了备注：刷新原来源层，旧备注不作为另一来源留下。两种写法重导都是同一来源。
        fixture.items[0]["annotation"] = json!("搬家后的备注");
        fixture.save_item(0);
        import(&library, &spelling(&moved));
        import(&library, &moved);
        assert_eagle_rows_at(&library, &id, &moved);
        let notes: Vec<_> = library
            .image(&id)
            .unwrap()
            .note
            .sources
            .into_iter()
            .map(|n| n.text)
            .collect();
        assert_eq!(notes, ["搬家后的备注"]);

        // 关闭重开后仍是同样的来源层。
        drop(library);
        let library = Library::open(&root).unwrap();
        assert_eagle_rows_at(&library, &id, &moved);
        assert_eq!(library.image(&id).unwrap().note.sources.len(), 1);
    }
}

#[test]
fn eagle_relocation_updates_sources_for_the_spelling_it_was_imported_with() {
    relocation_moves_every_source_row(Path::to_path_buf);
}

/// Windows 上同一目录可用不同大小写写出：首次迁入的写法与登记的规范路径大小写不同。
#[cfg(windows)]
#[test]
fn eagle_relocation_updates_sources_for_a_case_alias() {
    relocation_moves_every_source_row(|path| {
        let alias = std::path::PathBuf::from(path.to_string_lossy().to_lowercase());
        assert_ne!(alias, path, "测试路径需要含大写字母");
        alias
    });
}

#[test]
fn confirming_an_unknown_source_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 1);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let error = library
        .confirm_eagle_location(
            &fixture.root,
            EagleLocationChoice::Moved {
                source_id: "nope".into(),
            },
        )
        .unwrap_err();
    assert!(matches!(error, Error::UnknownEagleSource), "{error:?}");
    assert!(library.eagle_sources().unwrap().is_empty());
}
