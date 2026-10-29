use kinshoko_core::library::{BrowseQuery, ImageEdit, ImportSource};
use kinshoko_core::{DeviceLibraries, Library};

#[test]
fn editing_an_inactive_registered_provider_keeps_the_current_and_last_opened_library() {
    let temp = tempfile::tempdir().unwrap();
    let png = temp.path().join("same.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let a = Library::create(&temp.path().join("A"), "工作参考").unwrap();
    let b = Library::create(&temp.path().join("B"), "移动盘参考").unwrap();
    for library in [&a, &b] {
        library
            .import(ImportSource {
                paths: vec![png.clone()],
            })
            .wait();
    }
    let query = BrowseQuery {
        scope: Default::default(),
        conditions: Default::default(),
        cursor: None,
        limit: 10,
        thumbnail_px: 256,
    };
    let aid = a.browse(&query).unwrap().cards[0].id.clone();
    let bid = b.browse(&query).unwrap().cards[0].id.clone();
    let (a, b) = (a.info().clone(), b.info().clone());
    let app = temp.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    device.register(&a.root).unwrap();
    device.add_registration(&b.root).unwrap();
    device
        .write(&b.id)
        .unwrap()
        .edit(
            std::slice::from_ref(&bid),
            &[ImageEdit::SetNote {
                text: "只改移动盘来源".into(),
            }],
        )
        .unwrap();
    assert_eq!(
        device
            .read(&b.id)
            .unwrap()
            .image(&bid)
            .unwrap()
            .note
            .manual
            .as_deref(),
        Some("只改移动盘来源")
    );
    assert_eq!(
        device.read(&a.id).unwrap().image(&aid).unwrap().note.manual,
        None
    );
    assert_eq!(device.current().unwrap().info().id, a.id);
    drop(device);
    assert_eq!(
        DeviceLibraries::open(&app)
            .unwrap()
            .restore_last_opened()
            .unwrap()
            .unwrap()
            .info()
            .id,
        a.id
    );
}

#[test]
fn an_explicit_aggregate_source_edits_only_its_curation_and_rejects_a_changed_byte_identity() {
    use kinshoko_core::library::{ContentRating, TagEdit, TagNamespace, TagRef};
    use kinshoko_core::tag_catalog::TagCatalog;
    use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceSourceTarget};
    let temp = tempfile::tempdir().unwrap();
    let png = temp.path().join("same.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let mut device = DeviceLibraries::open(&temp.path().join("app")).unwrap();
    let a = device.create(&temp.path().join("A"), "工作参考").unwrap();
    a.import(ImportSource {
        paths: vec![png.clone()],
    })
    .wait();
    let b = Library::create(&temp.path().join("B"), "移动盘参考").unwrap();
    b.import(ImportSource { paths: vec![png] }).wait();
    device.add_registration(&b.info().root).unwrap();
    let mut catalog = TagCatalog::open(&temp.path().join("app")).unwrap();
    let mut workspace = Workspace::open(&temp.path().join("app")).unwrap();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                known_placeholders: Vec::new(),
            },
            true,
        )
        .unwrap();
    assert_eq!(page.cards.len(), 1);
    let card = &page.cards[0];
    let asource = card
        .sources
        .iter()
        .find(|s| s.library_id == a.info().id)
        .unwrap();
    let bsource = card
        .sources
        .iter()
        .find(|s| s.library_id == b.info().id)
        .unwrap();
    let target = WorkspaceSourceTarget {
        library_id: bsource.library_id.clone(),
        image_id: bsource.image_id.clone(),
        content_id: card.id.clone(),
    };
    let folder = b.create_folder("人物", None).unwrap();
    workspace
        .write_source(&mut device, &mut catalog, &target, true, |library| {
            library.edit(
                std::slice::from_ref(&target.image_id),
                &[
                    ImageEdit::SetNote {
                        text: "移动盘独立备注".into(),
                    },
                    ImageEdit::SetRating {
                        rating: ContentRating::Sensitive,
                    },
                    ImageEdit::AddToFolder {
                        folder_id: folder.clone(),
                    },
                ],
            )?;
            library.edit_tags(
                std::slice::from_ref(&target.image_id),
                &[TagEdit::Add {
                    tag: TagRef::Named {
                        namespace: TagNamespace::General,
                        name: "左手姿势".into(),
                        lang: "zh-CN".into(),
                    },
                }],
            )
        })
        .unwrap();
    let detail = workspace
        .read_source(&device, &mut catalog, &target, true)
        .unwrap()
        .image(&target.image_id)
        .unwrap();
    assert_eq!(detail.note.manual.as_deref(), Some("移动盘独立备注"));
    assert_eq!(detail.rating.manual, Some(ContentRating::Sensitive));
    assert_eq!(detail.folders[0].id, folder);
    assert_eq!(
        b.image_tags(&target.image_id, "zh-CN").unwrap().tags[0]
            .tag
            .name,
        "左手姿势"
    );
    let other = a.image(&asource.image_id).unwrap();
    assert_eq!(other.note.manual, None);
    assert_eq!(other.rating.manual, None);
    assert!(other.folders.is_empty());
    assert!(
        a.image_tags(&asource.image_id, "zh-CN")
            .unwrap()
            .tags
            .is_empty()
    );
    let changed = WorkspaceSourceTarget {
        content_id: "another-file".into(),
        ..target.clone()
    };
    let error = workspace
        .write_source(&mut device, &mut catalog, &changed, true, |library| {
            library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete])
        })
        .unwrap_err();
    assert!(error.to_string().contains("来源"));
    assert_eq!(b.image(&target.image_id).unwrap().deleted_at, None);
    workspace
        .write_source(&mut device, &mut catalog, &target, true, |library| {
            library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete])
        })
        .unwrap();
    assert!(b.image(&target.image_id).unwrap().deleted_at.is_some());
    assert_eq!(a.image(&asource.image_id).unwrap().deleted_at, None);
    assert_eq!(device.current().unwrap().info().id, a.info().id);
}

#[test]
fn unavailable_or_sealed_selected_sources_are_rejected_without_using_a_duplicate() {
    use kinshoko_core::library::{ContentRating, FactSource};
    use kinshoko_core::tag_catalog::TagCatalog;
    use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceSourceTarget};
    let temp = tempfile::tempdir().unwrap();
    let png = temp.path().join("same.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let mut device = DeviceLibraries::open(&temp.path().join("app")).unwrap();
    let a = device.create(&temp.path().join("A"), "工作参考").unwrap();
    a.import(ImportSource {
        paths: vec![png.clone()],
    })
    .wait();
    let b = Library::create(&temp.path().join("B"), "移动盘参考").unwrap();
    b.import(ImportSource { paths: vec![png] }).wait();
    device.add_registration(&b.info().root).unwrap();
    let mut catalog = TagCatalog::open(&temp.path().join("app")).unwrap();
    let mut workspace = Workspace::open(&temp.path().join("app")).unwrap();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                known_placeholders: Vec::new(),
            },
            true,
        )
        .unwrap();
    let card = &page.cards[0];
    let aid = card
        .sources
        .iter()
        .find(|s| s.library_id == a.info().id)
        .unwrap()
        .image_id
        .clone();
    let bid = card
        .sources
        .iter()
        .find(|s| s.library_id == b.info().id)
        .unwrap()
        .image_id
        .clone();
    let target = WorkspaceSourceTarget {
        library_id: b.info().id.clone(),
        image_id: bid.clone(),
        content_id: card.id.clone(),
    };
    a.replace_source_rating(
        &FactSource::model("safety-fixture"),
        &aid,
        Some(kinshoko_core::library::RatingFact {
            rating: ContentRating::Explicit,
            score: None,
        }),
    )
    .unwrap();
    assert!(
        workspace
            .read_source(&device, &mut catalog, &target, true)
            .is_err()
    );
    assert!(
        workspace
            .write_source(&mut device, &mut catalog, &target, true, |l| l
                .edit(std::slice::from_ref(&bid), &[ImageEdit::Delete]))
            .is_err()
    );
    assert_eq!(b.image(&bid).unwrap().deleted_at, None);
    let b_root = b.info().root.clone();
    drop(b);
    // 长期只读句柄（#313）握着时 Windows 上改不了名：模拟断开前先放掉，同应用壳登记变化时。
    workspace.release_readers();
    std::fs::rename(&b_root, temp.path().join("disconnected-B")).unwrap();
    let error = workspace
        .write_source(&mut device, &mut catalog, &target, false, |l| {
            l.edit(std::slice::from_ref(&bid), &[ImageEdit::Delete])
        })
        .unwrap_err()
        .to_string();
    assert!(error.contains("暂时不可用"));
    assert_eq!(
        a.image(&aid).unwrap_err().to_string(),
        "资料库中没有这张参考图"
    );
    assert_eq!(device.current().unwrap().info().id, a.info().id);
}

#[test]
fn pins_and_group_members_keep_the_selected_provider_after_requery_and_disconnection() {
    use kinshoko_core::desktop::PinContent;
    use kinshoko_core::reference_groups::ReferenceGroups;
    use kinshoko_core::tag_catalog::TagCatalog;
    use kinshoko_core::workspace::{
        Workspace, WorkspaceQuery, WorkspaceScope, WorkspaceSourceTarget,
    };
    let temp = tempfile::tempdir().unwrap();
    let png = temp.path().join("same.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let mut device = DeviceLibraries::open(&temp.path().join("app")).unwrap();
    let a = device.create(&temp.path().join("A"), "工作参考").unwrap();
    a.import(ImportSource {
        paths: vec![png.clone()],
    })
    .wait();
    let b = Library::create(&temp.path().join("B"), "移动盘参考").unwrap();
    b.import(ImportSource { paths: vec![png] }).wait();
    let binfo = b.info().clone();
    device.add_registration(&binfo.root).unwrap();
    let mut catalog = TagCatalog::open(&temp.path().join("app")).unwrap();
    let mut workspace = Workspace::open(&temp.path().join("app")).unwrap();
    let mut query = WorkspaceQuery {
        scope: Default::default(),
        conditions: Default::default(),
        cursor: None,
        limit: 10,
        known_placeholders: Vec::new(),
    };
    let page = workspace
        .browse(&device, &mut catalog, &query, true)
        .unwrap();
    let source = page.cards[0]
        .sources
        .iter()
        .find(|s| s.library_id == binfo.id)
        .unwrap();
    let target = WorkspaceSourceTarget {
        library_id: source.library_id.clone(),
        image_id: source.image_id.clone(),
        content_id: page.cards[0].id.clone(),
    };
    let mut pin = workspace
        .source_reference(&device, &mut catalog, &target, true)
        .unwrap();
    let groups = ReferenceGroups::open(&temp.path().join("app")).unwrap();
    let group = groups
        .create("姿势观察", std::slice::from_mut(&mut pin))
        .unwrap();
    query.scope = WorkspaceScope::Library {
        library_id: a.info().id.clone(),
        scope: Default::default(),
    };
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query, true)
            .unwrap()
            .total,
        1
    );
    assert!(
        matches!(&pin.content, PinContent::Reference { library_id, image_id, .. } if library_id == &target.library_id && image_id == &target.image_id)
    );
    assert_eq!(
        group.members[0].library_id(),
        Some(target.library_id.as_str())
    );
    assert_eq!(group.members[0].image_id(), Some(target.image_id.as_str()));
    drop(b);
    // 长期只读句柄（#313）握着时 Windows 上改不了名：模拟断开前先放掉，同应用壳登记变化时。
    workspace.release_readers();
    std::fs::rename(&binfo.root, temp.path().join("disconnected-B")).unwrap();
    assert!(
        workspace
            .read_source(&device, &mut catalog, &target, true)
            .is_err()
    );
    let persisted = ReferenceGroups::open(&temp.path().join("app"))
        .unwrap()
        .get(&group.id)
        .unwrap();
    assert_eq!(persisted.members, group.members);
    assert_eq!(device.current().unwrap().info().id, a.info().id);
}

/// 两个图库里有同一张图（字节相同），A 是可写库。
pub(crate) fn same_image_in_two_libraries(
    temp: &std::path::Path,
) -> (
    DeviceLibraries,
    std::sync::Arc<Library>,
    Library,
    kinshoko_core::tag_catalog::TagCatalog,
    kinshoko_core::workspace::Workspace,
) {
    let png = temp.join("same.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([20, 40, 60]))
        .save(&png)
        .unwrap();
    let mut device = DeviceLibraries::open(&temp.join("app")).unwrap();
    let a = device.create(&temp.join("A"), "工作参考").unwrap();
    a.import(ImportSource {
        paths: vec![png.clone()],
    })
    .wait();
    let b = Library::create(&temp.join("B"), "移动盘参考").unwrap();
    b.import(ImportSource { paths: vec![png] }).wait();
    device.add_registration(&b.info().root).unwrap();
    let catalog = kinshoko_core::tag_catalog::TagCatalog::open(&temp.join("app")).unwrap();
    let workspace = kinshoko_core::workspace::Workspace::open(&temp.join("app")).unwrap();
    (device, a, b, catalog, workspace)
}

pub(crate) fn wall_card(
    device: &DeviceLibraries,
    catalog: &mut kinshoko_core::tag_catalog::TagCatalog,
    workspace: &mut kinshoko_core::workspace::Workspace,
) -> kinshoko_core::workspace::WorkspaceCard {
    workspace
        .browse(
            device,
            catalog,
            &kinshoko_core::workspace::WorkspaceQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                known_placeholders: Vec::new(),
            },
            true,
        )
        .unwrap()
        .cards[0]
        .clone()
}

pub(crate) fn source_in(
    card: &kinshoko_core::workspace::WorkspaceCard,
    library: &Library,
) -> String {
    card.sources
        .iter()
        .find(|s| s.library_id == library.info().id)
        .unwrap()
        .image_id
        .clone()
}

/// 整理来源时用调用方按需取得的可写句柄（ADR-0008），不另开一个；句柄必须是所选来源的图库。
#[test]
fn a_source_edit_runs_on_the_given_writable_library_of_that_source() {
    use kinshoko_core::workspace::WorkspaceSourceTarget;
    let temp = tempfile::tempdir().unwrap();
    let (mut device, a, b, mut catalog, mut workspace) = same_image_in_two_libraries(temp.path());
    let card = wall_card(&device, &mut catalog, &mut workspace);
    let target = WorkspaceSourceTarget {
        library_id: b.info().id.clone(),
        image_id: source_in(&card, &b),
        content_id: card.id.clone(),
    };
    let error = workspace
        .write_source_with(&device, &mut catalog, &target, true, &a, |library| {
            library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete])
        })
        .unwrap_err();
    assert!(error.to_string().contains("来源"), "{error}");
    assert_eq!(b.image(&target.image_id).unwrap().deleted_at, None);

    let writer = match device.organize(&b.info().id).unwrap() {
        kinshoko_core::WriterAccess::Ready { library, .. } => library,
        kinshoko_core::WriterAccess::Waiting(_) => panic!("不应等待"),
    };
    workspace
        .write_source_with(&device, &mut catalog, &target, true, &writer, |library| {
            assert!(std::ptr::eq(library, &*writer), "就用给的那个句柄");
            library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete])
        })
        .unwrap();
    assert!(b.image(&target.image_id).unwrap().deleted_at.is_some());
    assert_eq!(a.image(&source_in(&card, &a)).unwrap().deleted_at, None);
}

/// 钉图“在 Kinshoko 中打开”要的卡片与图片墙同样构成：id 是字节身份，带全部来源，
/// 显示的是所请求的那份来源。查看器里的整理据此核对来源。
#[test]
fn a_single_source_card_is_built_like_the_wall_card() {
    use kinshoko_core::library::{ContentRating, FactSource};
    use kinshoko_core::workspace::WorkspaceSourceTarget;
    let temp = tempfile::tempdir().unwrap();
    let (mut device, a, b, mut catalog, mut workspace) = same_image_in_two_libraries(temp.path());
    let wall = wall_card(&device, &mut catalog, &mut workspace);
    let bid = source_in(&wall, &b);

    let card = workspace
        .card(&device, &mut catalog, &b.info().id, &bid, true)
        .unwrap();
    assert_eq!(card.id, wall.id, "卡片 id 是字节身份，不是图库里的图片 id");
    assert_ne!(card.id, bid);
    assert_eq!(card.library_id, b.info().id);
    assert_eq!(card.image_id, bid);
    assert_eq!((card.width, card.height), (wall.width, wall.height));
    assert_eq!(card.sources.len(), 2);
    assert!(!card.adult);
    // 查看器按这张卡整理：来源核对通过。
    let target = WorkspaceSourceTarget {
        library_id: card.library_id.clone(),
        image_id: card.image_id.clone(),
        content_id: card.id.clone(),
    };
    workspace
        .write_source(&mut device, &mut catalog, &target, true, |library| {
            library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete])
        })
        .unwrap();

    assert!(
        workspace
            .card(&device, &mut catalog, &b.info().id, "没有这张", true)
            .is_err()
    );
    a.replace_source_rating(
        &FactSource::model("safety-fixture"),
        &source_in(&wall, &a),
        Some(kinshoko_core::library::RatingFact {
            rating: ContentRating::Explicit,
            score: None,
        }),
    )
    .unwrap();
    assert!(
        workspace
            .card(&device, &mut catalog, &b.info().id, &bid, true)
            .is_err(),
        "安全模式下任何一份来源是成人内容就不给"
    );
    assert!(
        workspace
            .card(&device, &mut catalog, &b.info().id, &bid, false)
            .unwrap()
            .adult
    );
}
