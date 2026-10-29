//! Eagle 原有标签的叫法是本库的来源名称，语言按文字判断（#217，ADR-0012）。

#[path = "support/eagle.rs"]
#[allow(dead_code)]
mod eagle;

use std::collections::BTreeMap;
use std::path::Path;

use kinshoko_core::Library;
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    ExternalVocabulary, ImportOutcome, ImportSource, LocalizedName, TagAlias, TagEdit,
    TagNamespace, TagRef, TagTranslation, TagTranslations,
};
use kinshoko_core::search::Search;
use kinshoko_core::tag_catalog::TagCatalog;
use serde_json::json;

const ZH: &str = "zh-CN";

fn fixture(dir: &Path, tags: &[&[&str]]) -> eagle::EagleFixture {
    let fixture = eagle::build(&dir.join("主库.library"), "4.0.0", tags.len());
    let mut fixture = fixture;
    for (i, t) in tags.iter().enumerate() {
        fixture.items[i]["tags"] = json!(t);
        fixture.items[i]["isDeleted"] = json!(false);
        fixture.save_item(i);
    }
    fixture
}

fn import(library: &Library, fixture: &eagle::EagleFixture) -> Vec<String> {
    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait()
        .items
        .into_iter()
        .filter_map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } | ImportOutcome::Merged { image_id } => {
                Some(image_id)
            }
            _ => None,
        })
        .collect()
}

/// 外部词表：blue_eyes 的简中名称“蓝瞳”、简中别名“蓝眼睛”。
fn vocabulary() -> ExternalVocabulary {
    ExternalVocabulary::new(
        ["blue_eyes".to_owned()],
        &TagTranslations {
            entries: vec![TagTranslation {
                external: "blue_eyes".into(),
                names: BTreeMap::from([(ZH.to_owned(), "蓝瞳".to_owned())]),
                aliases: vec![TagAlias {
                    name: "蓝眼睛".into(),
                    lang: Some(ZH.into()),
                }],
            }],
        },
    )
}

/// 一张图的标签显示名。
fn shown(library: &Library, image: &str, lang: &str) -> Vec<String> {
    library
        .image_tags(image, lang)
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.tag.name)
        .collect()
}

fn source_names(library: &Library) -> Vec<LocalizedName> {
    let mut names: Vec<_> = library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .flat_map(|t| t.source_names)
        .collect();
    names.sort_by(|a, b| a.name.cmp(&b.name));
    names
}

fn n(lang: &str, name: &str) -> LocalizedName {
    LocalizedName {
        lang: lang.into(),
        name: name.into(),
    }
}

#[test]
fn eagle_originals_are_source_names_in_the_language_their_script_shows() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(
        dir.path(),
        &[
            &["blue eyes"],
            &["Blue_Eyes"],
            &["cyberpunk"],
            &["初音ミク"],
            &["蓝发 girl"],
            &["蓝眼睛"],
        ],
    );
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let images = import(&library, &fixture);

    // 迁入时不是简中名称，而是按文字判断语言的来源名称。
    let vocab = library.vocabulary().unwrap();
    assert!(vocab.tags.iter().all(|t| t.names.is_empty()));
    assert_eq!(
        source_names(&library),
        [
            n("en", "Blue_Eyes"),
            n("en", "blue eyes"),
            n("en", "cyberpunk"),
            n("ja", "初音ミク"),
            n("und", "蓝发 girl"),
            n(ZH, "蓝眼睛"),
        ]
    );

    library.map_eagle_tags(&vocabulary(), ZH).unwrap();

    assert_eq!(shown(&library, &images[0], ZH), ["蓝瞳"]);
    assert_eq!(shown(&library, &images[1], ZH), ["蓝瞳"]);
    assert_eq!(shown(&library, &images[2], ZH), ["cyberpunk"]);
    assert_eq!(shown(&library, &images[3], ZH), ["初音ミク"]);
    assert_eq!(shown(&library, &images[4], ZH), ["蓝发 girl"]);
    // 同库的“蓝眼睛”也对上 blue_eyes：并入同一个标签，只作简中别名，显示默认名称（#217 维护者选定）。
    assert_eq!(shown(&library, &images[5], ZH), ["蓝瞳"]);
    // blue eyes 与 Blue_Eyes 对应同一个外部名称：并成一个标签，原文成为不分语言的别名。
    let vocab = library.vocabulary().unwrap();
    let blue = vocab
        .tags
        .iter()
        .find(|t| t.external == ["blue_eyes"])
        .unwrap();
    assert_eq!(blue.count, 3);
    assert!(blue.source_names.is_empty());
    assert!(blue.aliases.contains(&TagAlias {
        name: "blue eyes".into(),
        lang: None
    }));
    assert!(blue.aliases.contains(&TagAlias {
        name: "蓝眼睛".into(),
        lang: Some(ZH.into())
    }));
    // 来源名称不算尚未翻译。
    let tags = library.image_tags(&images[2], ZH).unwrap();
    assert!(!tags.tags[0].tag.untranslated);
    // 按原文仍能查到。
    let search = Search::new(&vocab, &BuiltinApproxTable::bundled());
    assert!(
        search
            .candidates("blue eyes", ZH, 10)
            .iter()
            .any(|c| c.tag.id == blue.id)
    );
}

#[test]
fn an_original_alone_that_is_a_translation_alias_becomes_a_source_name_in_that_language() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["蓝眼睛"]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let images = import(&library, &fixture);
    assert_eq!(source_names(&library), [n(ZH, "蓝眼睛")]);

    library.map_eagle_tags(&vocabulary(), ZH).unwrap();

    // 对上翻译表中的简中别名：仍是简中来源名称，优先于默认名称“蓝瞳”。
    assert_eq!(source_names(&library), [n(ZH, "蓝眼睛")]);
    assert_eq!(shown(&library, &images[0], ZH), ["蓝眼睛"]);
}

#[test]
fn an_eagle_tag_whose_external_already_belongs_to_a_model_tag_is_merged_into_it() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["blue eyes"], &["蓝眼睛"]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let images = import(&library, &fixture);
    // 模型先打出了 blue_eyes（“蓝瞳”）。
    library
        .edit_tags(
            std::slice::from_ref(&images[0]),
            &[TagEdit::Add {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: "blue_eyes".into(),
                },
            }],
        )
        .unwrap();

    let mapping = library.map_eagle_tags(&vocabulary(), ZH).unwrap();

    let blue: Vec<_> = library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .filter(|t| t.count > 0)
        .collect();
    assert_eq!(blue.len(), 1, "库里只剩一个标签");
    assert_eq!(blue[0].count, 2);
    assert!(
        mapping
            .matched
            .iter()
            .all(|m| m.merged_into.as_ref().map(|t| t.id.as_str()) == Some(blue[0].id.as_str()))
    );
    assert_eq!(mapping.matched.len(), 2);
    // 重新迁入：两段原文都还落在这个标签上。
    import(&library, &fixture);
    let after: Vec<_> = library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .filter(|t| t.count > 0)
        .collect();
    assert_eq!(after.len(), 1);
}

#[test]
fn reimporting_follows_eagle_renames_but_keeps_name_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = fixture(dir.path(), &[&["暖色调"], &["cyberpunk"]]);
    let app = dir.path().join("app");
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let images = import(&library, &fixture);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let snapshot = catalog.synchronize(&library).unwrap();
    let shown_in_catalog = |catalog: &mut TagCatalog, image: &str| -> String {
        catalog.image_tags(&library, image, ZH).unwrap().image.tags[0]
            .tag
            .name
            .clone()
    };
    assert_eq!(shown_in_catalog(&mut catalog, &images[0]), "暖色调");
    let cyber = snapshot
        .tags
        .iter()
        .find(|t| t.source_names.iter().any(|s| s.name == "cyberpunk"))
        .unwrap()
        .id
        .clone();
    catalog
        .set_name_preference(&cyber, &n(ZH, "赛博朋克"))
        .unwrap();

    fixture.items[0]["tags"] = json!(["暖色系"]);
    fixture.save_item(0);
    fixture.items[1]["modificationTime"] = json!(1);
    fixture.save_item(1);
    import(&library, &fixture);

    assert_eq!(shown_in_catalog(&mut catalog, &images[0]), "暖色系");
    assert_eq!(shown_in_catalog(&mut catalog, &images[1]), "赛博朋克");
    // 跨库显示：名称偏好 > 默认名称 > 来源名称。
    let inspection = catalog.synchronize(&library).unwrap();
    let warm = inspection
        .tags
        .iter()
        .find(|t| t.source_names.iter().any(|s| s.name == "暖色系"))
        .unwrap();
    assert_eq!(warm.names, [n(ZH, "暖色系")]);
    assert!(warm.default_names.is_empty());
}

/// beta1 迁入过的库：Eagle 原文记成了简中名称，迁入向导写过外部对应。
#[test]
fn a_beta1_library_upgrades_its_eagle_names_into_source_names() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(
        dir.path(),
        &[
            &["blue eyes"],
            &["cyberpunk"],
            &["改过的"],
            &["蓝眼睛"],
            &["我的叫法"],
            &["随手"],
        ],
    );
    let root = dir.path().join("kinshoko");
    let library = Library::create(&root, "参考").unwrap();
    let images = import(&library, &fixture);
    drop(library);
    {
        // 退回 beta1：原文记成简中名称，向导给 blue eyes 写了外部对应；画师把“改过的”改成了“我的叫法”。
        let conn = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
        let version = include_str!("../src/library/store.rs")
            .lines()
            .filter_map(|line| {
                line.split_once("include_str!(\"migrations/")
                    .map(|(_, name)| name)
            })
            .position(|name| name.starts_with("0217_tag_source_name.sql\""))
            .expect("来源名称迁移必须存在");
        conn.execute_batch(&format!(
            "INSERT INTO tag_name (tag_id, lang, name)
                 SELECT tag_id, 'zh-CN', name FROM tag_source_name;
             INSERT INTO tag_external (name, tag_id)
                 SELECT 'blue_eyes', tag_id FROM tag_source_name WHERE name = 'blue eyes';
             UPDATE tag_name SET name = '我的叫法' WHERE name = '改过的';
             UPDATE tag_name SET name = 'blue eyes' WHERE name = '随手';
             DROP TABLE tag_source_name;
             PRAGMA user_version = {version};"
        ))
        .unwrap();
    }

    let library = Library::open(&root).unwrap();

    assert_eq!(shown(&library, &images[1], ZH), ["cyberpunk"]);
    assert_eq!(shown(&library, &images[2], ZH), ["我的叫法"]);
    // 改过的名称恰好是外部名称的写法：也不重新匹配、不并入。
    assert_eq!(shown(&library, &images[5], ZH), ["blue eyes"]);
    // 重新匹配：“蓝眼睛”对上内置翻译表的 blue_eyes，并入 blue eyes 那个标签，只作简中别名；
    // 两张图都显示默认名称“蓝瞳”。
    assert_eq!(shown(&library, &images[3], ZH), ["蓝瞳"]);
    assert_eq!(shown(&library, &images[0], ZH), ["蓝瞳"]);
    let vocab = library.vocabulary().unwrap();
    let blue = vocab
        .tags
        .iter()
        .find(|t| t.external == ["blue_eyes"])
        .unwrap();
    assert_eq!(blue.count, 2);
    assert!(blue.source_names.is_empty());
    assert!(blue.aliases.contains(&TagAlias {
        name: "蓝眼睛".into(),
        lang: Some(ZH.into()),
    }));
    let cyber = vocab
        .tags
        .iter()
        .find(|t| t.source_names.iter().any(|s| s.name == "cyberpunk"))
        .unwrap();
    assert_eq!(cyber.source_names, [n("en", "cyberpunk")]);
    // 画师改过的名称即使与别的条目的 Eagle 原文相同也不动；那个条目自己的标签照常升级。
    assert!(
        vocab
            .tags
            .iter()
            .any(|t| t.names == [n(ZH, "我的叫法")] && t.source_names.is_empty())
    );
    assert!(
        vocab
            .tags
            .iter()
            .any(|t| t.names.is_empty() && t.source_names == [n(ZH, "我的叫法")])
    );
}

#[test]
fn eagle_files_are_unchanged_by_importing_and_mapping() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["blue eyes", "蓝眼睛"]]);
    let snapshot = |root: &Path| -> BTreeMap<String, Vec<u8>> { walk(root) };
    let before = snapshot(&fixture.root);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    import(&library, &fixture);
    library.map_eagle_tags(&vocabulary(), ZH).unwrap();
    assert_eq!(snapshot(&fixture.root), before);
}

fn walk(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_owned()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().display().to_string(),
                    std::fs::read(&path).unwrap(),
                );
            }
        }
    }
    out
}

/// beta1 的统一标签目录把 Eagle 原文同步成了默认名称；资料库升级后目录不再把它当默认名称。
#[test]
fn catalog_defaults_copied_from_beta1_eagle_names_are_dropped_after_the_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["cyberpunk"]]);
    let root = dir.path().join("kinshoko");
    let library = Library::create(&root, "参考").unwrap();
    let images = import(&library, &fixture);
    drop(library);
    let edit = |sql: &str| {
        rusqlite::Connection::open(root.join("library.sqlite"))
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    };
    // beta1：原文是简中名称，统一标签目录首次同步时把它抄成了默认名称。
    edit(
        "INSERT INTO tag_name (tag_id, lang, name) SELECT tag_id, 'zh-CN', name FROM tag_source_name;",
    );
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let library = Library::open(&root).unwrap();
    let before = catalog.synchronize(&library).unwrap();
    assert_eq!(before.tags[0].default_names, [n(ZH, "cyberpunk")]);
    drop(library);
    // 升级后原文只是来源名称。升级由新版本在下次启动时做：这里直接改库，词表修订号不动，
    // 同一个目录对象会当作没有变化（#335）；目录里的同步记录是旧版本写下的，新版本不认（#337）。
    edit("DELETE FROM tag_name;");
    drop(catalog);
    rusqlite::Connection::open(dir.path().join("app").join("tag-catalog.sqlite"))
        .unwrap()
        .execute_batch("UPDATE catalog_library_synchronized SET program='1.0.0-beta.1';")
        .unwrap();
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let library = Library::open(&root).unwrap();

    let after = catalog.synchronize(&library).unwrap();

    assert!(after.tags[0].default_names.is_empty());
    assert_eq!(after.tags[0].names, [n("en", "cyberpunk")]);
    let tag = &catalog
        .image_tags(&library, &images[0], ZH)
        .unwrap()
        .image
        .tags[0]
        .tag;
    assert_eq!(tag.name, "cyberpunk");
    assert!(!tag.untranslated);
}

#[test]
fn a_reference_group_package_carries_source_names_to_the_destination_library() {
    use kinshoko_core::library::PackageOrigin;
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["cyberpunk"]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let images = import(&library, &fixture);
    let lens = library.take_reference_lens().unwrap();
    let mut snapshot = lens.snapshot(&images[0]).unwrap();
    assert_eq!(snapshot.tags[0].names, [n("en", "cyberpunk")]);
    // 导出与跨库复制会按统一标签目录改写快照里的定义；来源名称要留下。
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog
        .synchronize(&library)
        .unwrap()
        .apply_content_definitions(&library.info().id, &mut snapshot)
        .unwrap();
    assert_eq!(snapshot.tags[0].names, [n("en", "cyberpunk")]);

    let second = Library::create(&dir.path().join("second"), "第二个").unwrap();
    let copied = second
        .import_from_package(
            &PackageOrigin {
                package_id: "fixture".into(),
                source_library_id: library.info().id.clone(),
                source_image_id: images[0].clone(),
                group_id: "fixture-group".into(),
                group_name: "参考组".into(),
                exported_at: 1,
                location: "fixture.kinshoko-group".into(),
            },
            &std::fs::read(lens.original_path(&images[0]).unwrap()).unwrap(),
            &snapshot,
        )
        .unwrap();

    assert_eq!(shown(&second, &copied, ZH), ["cyberpunk"]);
}

#[test]
fn the_artist_corrects_a_misjudged_language_and_reimporting_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&["hatsune miku"]]);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    import(&library, &fixture);
    let tag = library.vocabulary().unwrap().tags[0].id.clone();
    assert_eq!(source_names(&library), [n("en", "hatsune miku")]);

    library
        .set_source_name_lang(&tag, "hatsune miku", "ja")
        .unwrap();
    import(&library, &fixture);

    assert_eq!(source_names(&library), [n("ja", "hatsune miku")]);
    assert!(
        library
            .set_source_name_lang(&tag, "没有这个叫法", "ja")
            .is_err()
    );
}

/// 只有 Eagle 原文的去处才算 beta1 抄错的默认名称；画师改名留下的别名不影响统一标签目录。
#[test]
fn an_ordinary_rename_kept_as_an_alias_does_not_drop_catalog_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = fixture(dir.path(), &[&[]]);
    let root = dir.path().join("kinshoko");
    let library = Library::create(&root, "参考").unwrap();
    let images = import(&library, &fixture);
    library
        .edit_tags(
            std::slice::from_ref(&images[0]),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "旧名".into(),
                    lang: ZH.into(),
                },
            }],
        )
        .unwrap();
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&library).unwrap();
    let tag = library.vocabulary().unwrap().tags[0].id.clone();
    library.rename_tag(&tag, ZH, "新名").unwrap();
    library
        .add_tag_alias(
            &tag,
            &TagAlias {
                name: "旧名".into(),
                lang: None,
            },
        )
        .unwrap();

    let inspection = catalog.synchronize(&library).unwrap();

    assert_eq!(inspection.tags[0].default_names, [n(ZH, "旧名")]);
}
