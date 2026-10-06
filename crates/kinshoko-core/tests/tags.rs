//! 标签与人工标签决定（#51）：标签身份、命名空间、多语言名称与别名、标签分组、
//! 按来源分层写入与 `vocabulary()`。全部通过 `Library` 的对外接口，用临时目录里的真库。

use std::path::Path;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    Error, FactSource, ImageTags, ImportOutcome, ImportSource, LibraryEvent, LocalizedName,
    SourceTag, TagAlias, TagEdit, TagNamespace, TagOrigin, TagRef, TagTranslation, TagTranslations,
};

const ZH: &str = "zh-CN";

/// 建库并导入 `n` 张内容不同的图，返回资料库与参考图 id。
fn library_with_images(dir: &Path, n: u8) -> (Library, Vec<String>) {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
    let paths: Vec<_> = (0..n)
        .map(|i| {
            let path = dir.join(format!("in/{i}.png"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect();
    let report = library.import(ImportSource { paths }).wait();
    let ids = report
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect();
    (library, ids)
}

fn named(namespace: TagNamespace, name: &str) -> TagRef {
    TagRef::Named {
        namespace,
        name: name.into(),
        lang: ZH.into(),
    }
}

fn add(name: &str) -> TagEdit {
    TagEdit::Add {
        tag: named(TagNamespace::General, name),
    }
}

/// 有效标签的显示名，按名称排序。
fn effective_names(tags: &ImageTags) -> Vec<String> {
    let mut names: Vec<String> = tags.tags.iter().map(|t| t.tag.name.clone()).collect();
    names.sort();
    names
}

#[test]
fn an_added_tag_shows_as_a_manual_tag_of_that_image_only() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 2);

    library
        .edit_tags(&ids[..1], &[add("短发"), add("齐刘海")])
        .unwrap();

    let tags = library.image_tags(&ids[0], ZH).unwrap();
    assert_eq!(effective_names(&tags), ["短发", "齐刘海"]);
    for tag in &tags.tags {
        assert_eq!(tag.origins, [TagOrigin::Manual]);
        assert!(!tag.tag.untranslated);
    }
    assert!(tags.rejected.is_empty());
    assert!(library.image_tags(&ids[1], ZH).unwrap().tags.is_empty());
}

fn external(name: &str, score: Option<f32>) -> SourceTag {
    SourceTag {
        tag: TagRef::External {
            namespace: TagNamespace::General,
            name: name.into(),
        },
        score,
    }
}

fn eagle_tag(name: &str) -> SourceTag {
    SourceTag {
        tag: named(TagNamespace::General, name),
        score: None,
    }
}

fn tag_id(library: &Library, image_id: &str, name: &str) -> String {
    let tags = library.image_tags(image_id, ZH).unwrap();
    tags.tags
        .iter()
        .map(|t| &t.tag)
        .chain(&tags.rejected)
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("没有标签 {name}"))
        .id
        .clone()
}

#[test]
fn a_source_rewrite_replaces_only_its_own_layer_and_never_manual_decisions() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    let img = &ids[0];
    let model = FactSource::model("pixai-v1.0");
    let eagle = FactSource::eagle("主库");

    library
        .replace_source_tags(&eagle, img, &[eagle_tag("长发"), eagle_tag("水手服")])
        .unwrap();
    library
        .replace_source_tags(
            &model,
            img,
            &[
                external("long_hair", Some(0.9)),
                external("smile", Some(0.6)),
            ],
        )
        .unwrap();
    // 画师否决模型的“smile”，否决 Eagle 的“水手服”，再手动添加“回眸”。
    let smile = tag_id(&library, img, "smile");
    let sailor = tag_id(&library, img, "水手服");
    library
        .edit_tags(
            std::slice::from_ref(img),
            &[
                TagEdit::Reject {
                    tag: TagRef::Id { id: smile.clone() },
                },
                TagEdit::Reject {
                    tag: TagRef::Id { id: sailor },
                },
                add("回眸"),
            ],
        )
        .unwrap();

    // 重新打标：模型这次给出 smile 与 open_mouth，不再给 long_hair。
    library
        .replace_source_tags(
            &model,
            img,
            &[
                external("smile", Some(0.8)),
                external("open_mouth", Some(0.5)),
            ],
        )
        .unwrap();
    // Eagle 重导：只剩“长发”。
    library
        .replace_source_tags(&eagle, img, &[eagle_tag("长发")])
        .unwrap();

    let tags = library.image_tags(img, ZH).unwrap();
    assert_eq!(effective_names(&tags), ["open mouth", "回眸", "长发"]);
    let rejected: Vec<&str> = tags.rejected.iter().map(|t| t.name.as_str()).collect();
    // 人工否决不随来源事实消失：Eagle 不再给“水手服”，否决仍在。
    assert_eq!(rejected, ["smile", "水手服"]);
    let origins = |name: &str| {
        tags.tags
            .iter()
            .find(|t| t.tag.name == name)
            .unwrap()
            .origins
            .clone()
    };
    assert_eq!(
        origins("open mouth"),
        [TagOrigin::Source {
            source: "model:pixai-v1.0".into(),
            score: Some(0.5)
        }]
    );
    assert_eq!(
        origins("长发"),
        [TagOrigin::Source {
            source: "eagle:主库".into(),
            score: None
        }]
    );
    assert_eq!(origins("回眸"), [TagOrigin::Manual]);

    // 清除否决后，模型这一层的事实重新生效。
    library
        .edit_tags(
            std::slice::from_ref(img),
            &[TagEdit::Clear {
                tag: TagRef::Id { id: smile },
            }],
        )
        .unwrap();
    let tags = library.image_tags(img, ZH).unwrap();
    assert!(effective_names(&tags).contains(&"smile".to_owned()));
    assert_eq!(tags.rejected.len(), 1);
}

#[test]
fn clearing_a_manual_addition_leaves_the_source_fact_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    let img = std::slice::from_ref(&ids[0]);
    library
        .replace_source_tags(&FactSource::file(), &ids[0], &[eagle_tag("风景")])
        .unwrap();
    library.edit_tags(img, &[add("风景"), add("夕阳")]).unwrap();

    library
        .edit_tags(
            img,
            &[
                TagEdit::Clear {
                    tag: named(TagNamespace::General, "风景"),
                },
                TagEdit::Clear {
                    tag: named(TagNamespace::General, "夕阳"),
                },
            ],
        )
        .unwrap();

    let tags = library.image_tags(&ids[0], ZH).unwrap();
    assert_eq!(effective_names(&tags), ["风景"]);
    assert_eq!(
        tags.tags[0].origins,
        [TagOrigin::Source {
            source: "file".into(),
            score: None
        }]
    );
}

#[test]
fn a_batch_addition_tags_every_selected_image_with_one_shared_tag() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 3);

    library.edit_tags(&ids, &[add("双马尾")]).unwrap();

    let tag_ids: Vec<String> = ids.iter().map(|i| tag_id(&library, i, "双马尾")).collect();
    assert!(tag_ids.iter().all(|t| t == &tag_ids[0]));
    let vocabulary = library.vocabulary().unwrap();
    assert_eq!(vocabulary.tags.len(), 1);
    assert_eq!(vocabulary.tags[0].count, 3);
}

#[test]
fn the_same_name_in_two_namespaces_is_two_tags() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    let img = std::slice::from_ref(&ids[0]);

    library
        .edit_tags(
            img,
            &[
                TagEdit::Add {
                    tag: named(TagNamespace::Artist, "白"),
                },
                TagEdit::Add {
                    tag: named(TagNamespace::Character, "白"),
                },
                add("白"),
            ],
        )
        .unwrap();

    let tags = library.image_tags(&ids[0], ZH).unwrap();
    let mut seen: Vec<(TagNamespace, &str)> = tags
        .tags
        .iter()
        .map(|t| (t.tag.namespace, t.tag.name.as_str()))
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        [
            (TagNamespace::General, "白"),
            (TagNamespace::Artist, "白"),
            (TagNamespace::Character, "白"),
        ]
    );
    assert_eq!(library.vocabulary().unwrap().tags.len(), 3);

    // 只否决角色“白”，作者“白”不受影响。
    let character = tags
        .tags
        .iter()
        .find(|t| t.tag.namespace == TagNamespace::Character)
        .unwrap()
        .tag
        .id
        .clone();
    library
        .edit_tags(
            img,
            &[TagEdit::Reject {
                tag: TagRef::Id { id: character },
            }],
        )
        .unwrap();
    let tags = library.image_tags(&ids[0], ZH).unwrap();
    assert_eq!(tags.tags.len(), 2);
    assert_eq!(tags.rejected[0].namespace, TagNamespace::Character);
}

fn translations() -> TagTranslations {
    TagTranslations {
        entries: vec![TagTranslation {
            external: "blue_eyes".into(),
            names: [("zh-CN", "蓝瞳"), ("en", "blue eyes"), ("ja", "青い目")]
                .map(|(l, n)| (l.to_owned(), n.to_owned()))
                .into(),
            aliases: vec![TagAlias {
                name: "蓝眼睛".into(),
                lang: Some("zh-CN".into()),
            }],
        }],
    }
}

#[test]
fn external_names_take_their_first_names_from_the_translation_table_or_come_in_untranslated() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    library.set_translations(translations());

    library
        .replace_source_tags(
            &FactSource::model("pixai-v1.0"),
            &ids[0],
            &[
                external("blue_eyes", Some(0.9)),
                external("ahoge", Some(0.7)),
            ],
        )
        .unwrap();

    let label = |lang: &str, has: &str| {
        library
            .image_tags(&ids[0], lang)
            .unwrap()
            .tags
            .into_iter()
            .map(|t| t.tag)
            .find(|t| t.name == has)
            .unwrap_or_else(|| panic!("{lang} 下没有 {has}"))
    };
    let zh = label("zh-CN", "蓝瞳");
    assert!(!zh.untranslated && zh.has_external);
    assert_eq!(label("en", "blue eyes").id, zh.id);
    assert_eq!(label("ja", "青い目").id, zh.id);
    // 没有翻译：外部名称照常进库，下划线换成空格，标明尚未翻译。
    let ahoge = label("zh-CN", "ahoge");
    assert!(ahoge.untranslated && ahoge.has_external);

    // 画师之后改的名称属于整理数据；再次进库或更新翻译表不会改回去。
    library.rename_tag(&zh.id, "zh-CN", "蓝色眼睛").unwrap();
    library.set_translations(TagTranslations::default());
    library
        .replace_source_tags(
            &FactSource::model("pixai-v1.0"),
            &ids[0],
            &[external("blue_eyes", Some(0.8))],
        )
        .unwrap();
    assert_eq!(label("zh-CN", "蓝色眼睛").id, zh.id);

    // 画师给尚未翻译的标签起了名字，就不再标明尚未翻译。
    library.rename_tag(&ahoge.id, "zh-CN", "呆毛").unwrap();
    library
        .replace_source_tags(
            &FactSource::model("pixai-v1.0"),
            &ids[0],
            &[external("ahoge", Some(0.8))],
        )
        .unwrap();
    assert!(!label("zh-CN", "呆毛").untranslated);
}

#[test]
fn a_tag_resolves_by_any_of_its_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 2);
    library.edit_tags(&ids[..1], &[add("蓝发")]).unwrap();
    let blue = tag_id(&library, &ids[0], "蓝发");

    library
        .add_tag_alias(
            &blue,
            &TagAlias {
                name: "蓝头发".into(),
                lang: Some(ZH.into()),
            },
        )
        .unwrap();
    library.edit_tags(&ids[1..], &[add("蓝头发")]).unwrap();

    assert_eq!(tag_id(&library, &ids[1], "蓝发"), blue);
    let vocabulary = library.vocabulary().unwrap();
    assert_eq!(vocabulary.tags.len(), 1);
    assert_eq!(
        vocabulary.tags[0].aliases,
        [TagAlias {
            name: "蓝头发".into(),
            lang: Some(ZH.into())
        }]
    );

    // 别名移除后，同一叫法会新建标签。
    library.remove_tag_alias(&blue, "蓝头发").unwrap();
    library.edit_tags(&ids[1..], &[add("蓝头发")]).unwrap();
    assert_eq!(library.vocabulary().unwrap().tags.len(), 2);
}

#[test]
fn a_name_shared_by_two_tags_of_one_namespace_must_be_picked_by_id() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    library
        .edit_tags(&ids, &[add("马尾"), add("侧马尾")])
        .unwrap();
    let side = tag_id(&library, &ids[0], "侧马尾");
    let pony = tag_id(&library, &ids[0], "马尾");

    assert!(matches!(
        library.rename_tag(&side, ZH, "马尾"),
        Err(Error::DuplicateTagName(_))
    ));
    for id in [&side, &pony] {
        library
            .add_tag_alias(
                id,
                &TagAlias {
                    name: "辫子".into(),
                    lang: None,
                },
            )
            .unwrap();
    }
    assert!(matches!(
        library.edit_tags(&ids, &[add("辫子")]),
        Err(Error::AmbiguousTag(_))
    ));
}

#[test]
fn vocabulary_is_a_snapshot_of_tags_names_aliases_namespaces_externals_and_counts() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 3);
    library.set_translations(translations());
    let before = library.vocabulary().unwrap().revision;

    for id in &ids[..2] {
        library
            .replace_source_tags(
                &FactSource::model("m"),
                id,
                &[external("blue_eyes", Some(0.9))],
            )
            .unwrap();
    }
    // 第二张否决蓝瞳，第三张手动添加：计数按有效标签算。
    let blue = tag_id(&library, &ids[0], "蓝瞳");
    library
        .edit_tags(
            &ids[1..2],
            &[TagEdit::Reject {
                tag: TagRef::Id { id: blue.clone() },
            }],
        )
        .unwrap();
    library
        .edit_tags(
            &ids[2..],
            &[TagEdit::Add {
                tag: TagRef::Id { id: blue.clone() },
            }],
        )
        .unwrap();
    library
        .edit_tags(
            &ids[..1],
            &[TagEdit::Add {
                tag: named(TagNamespace::Work, "原创"),
            }],
        )
        .unwrap();
    library.add_tag_external(&blue, "aqua_eyes").unwrap();

    let vocabulary = library.vocabulary().unwrap();
    assert!(vocabulary.revision > before);
    let tag = vocabulary.tags.iter().find(|t| t.id == blue).unwrap();
    assert_eq!(tag.namespace, TagNamespace::General);
    assert_eq!(
        tag.names,
        [("en", "blue eyes"), ("ja", "青い目"), ("zh-CN", "蓝瞳")].map(|(l, n)| LocalizedName {
            lang: l.into(),
            name: n.into()
        })
    );
    assert_eq!(tag.aliases[0].name, "蓝眼睛");
    assert_eq!(tag.external, ["aqua_eyes", "blue_eyes"]);
    assert_eq!(tag.count, 2);
    let work = vocabulary.tags.iter().find(|t| t.id != blue).unwrap();
    assert_eq!(work.namespace, TagNamespace::Work);
    assert!(work.external.is_empty());
    assert_eq!(work.count, 1);

    // 一个外部名称只对应一个标签；被拒绝的编辑不改变修订号。
    let work_id = work.id.clone();
    assert!(matches!(
        library.add_tag_external(&work_id, "blue_eyes"),
        Err(Error::ExternalTaken(_))
    ));
    assert_eq!(library.vocabulary().unwrap().revision, vocabulary.revision);
}

#[test]
fn tag_groups_list_their_tags_with_counts_in_the_interface_language() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 2);
    library
        .edit_tags(&ids, &[add("蓝发"), add("紫发")])
        .unwrap();
    library
        .edit_tags(
            &ids[..1],
            &[
                add("短发"),
                TagEdit::Add {
                    tag: named(TagNamespace::Work, "原创"),
                },
            ],
        )
        .unwrap();
    let blue = tag_id(&library, &ids[0], "蓝发");
    let purple = tag_id(&library, &ids[0], "紫发");
    library.rename_tag(&blue, "en", "blue hair").unwrap();

    let hair = library.create_tag_group("发色", None).unwrap();
    library
        .set_tag_group_tags(&hair, &[purple.clone(), blue.clone()])
        .unwrap();
    let works = library
        .create_tag_group("作品", Some(TagNamespace::Work))
        .unwrap();
    assert!(matches!(
        library.set_tag_group_tags(&works, std::slice::from_ref(&blue)),
        Err(Error::NamespaceGroup)
    ));

    let groups = library.tag_groups("en").unwrap();
    let shown: Vec<(&str, Vec<(&str, u32)>)> = groups
        .iter()
        .map(|g| {
            (
                g.name.as_str(),
                g.tags
                    .iter()
                    .map(|t| (t.tag.name.as_str(), t.count))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("发色", vec![("紫发", 2), ("blue hair", 2)]),
            ("作品", vec![("原创", 1)]),
        ]
    );

    // 编辑：改名、调整顺序、删除。
    library.rename_tag_group(&hair, "头发颜色").unwrap();
    library
        .order_tag_groups(&[works.clone(), hair.clone()])
        .unwrap();
    let names: Vec<String> = library
        .tag_groups(ZH)
        .unwrap()
        .into_iter()
        .map(|g| g.name)
        .collect();
    assert_eq!(names, ["作品", "头发颜色"]);
    library.delete_tag_group(&works).unwrap();
    assert_eq!(library.tag_groups(ZH).unwrap().len(), 1);
}

#[test]
fn tags_decisions_and_groups_survive_reopening_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    library
        .replace_source_tags(
            &FactSource::model("m"),
            &ids[0],
            &[external("smile", Some(0.6))],
        )
        .unwrap();
    library.edit_tags(&ids, &[add("短发")]).unwrap();
    let smile = tag_id(&library, &ids[0], "smile");
    library
        .edit_tags(
            &ids,
            &[TagEdit::Reject {
                tag: TagRef::Id { id: smile },
            }],
        )
        .unwrap();
    let group = library.create_tag_group("发型", None).unwrap();
    let short = tag_id(&library, &ids[0], "短发");
    library.set_tag_group_tags(&group, &[short]).unwrap();
    let tags = library.image_tags(&ids[0], ZH).unwrap();
    let vocabulary = library.vocabulary().unwrap();
    let groups = library.tag_groups(ZH).unwrap();
    drop(library);

    let reopened = Library::open(&dir.path().join("lib")).unwrap();
    assert_eq!(reopened.image_tags(&ids[0], ZH).unwrap(), tags);
    assert_eq!(reopened.vocabulary().unwrap(), vocabulary);
    assert_eq!(reopened.tag_groups(ZH).unwrap(), groups);
}

#[test]
fn tag_changes_are_announced_after_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    let events = library.events();

    library.edit_tags(&ids, &[add("短发")]).unwrap();

    let received: Vec<LibraryEvent> = events.try_iter().collect();
    let library_id = library.info().id.clone();
    assert!(received.contains(&LibraryEvent::ImagesChanged {
        library_id: library_id.clone(),
        image_ids: ids.clone(),
    }));
    assert!(received.contains(&LibraryEvent::VocabularyChanged {
        library_id,
        revision: library.vocabulary().unwrap().revision,
    }));
}

#[test]
fn editing_an_unknown_image_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with_images(dir.path(), 1);
    let before = library.vocabulary().unwrap();

    let result = library.edit_tags(&[ids[0].clone(), "不存在".into()], &[add("短发")]);

    assert!(matches!(result, Err(Error::UnknownImage)));
    assert_eq!(library.vocabulary().unwrap(), before);
    assert!(library.image_tags(&ids[0], ZH).unwrap().tags.is_empty());
}
