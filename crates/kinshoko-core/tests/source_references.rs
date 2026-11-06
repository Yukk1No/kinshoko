use super::source_actions::{same_image_in_two_libraries, source_in, wall_card, write_source};
use kinshoko_core::DeviceLibraries;
use kinshoko_core::Library;
use kinshoko_core::library::{ImageEdit, ImportSource};

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
    write_source(
        &mut workspace,
        &mut device,
        &mut catalog,
        &target,
        true,
        |library| library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete]),
    )
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
