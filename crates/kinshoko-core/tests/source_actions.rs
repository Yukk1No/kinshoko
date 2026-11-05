use kinshoko_core::library::{BrowseQuery, ImageEdit, ImportSource};
use kinshoko_core::tag_catalog::{CatalogError, TagCatalog};
use kinshoko_core::workspace::{Workspace, WorkspaceSourceTarget};
use kinshoko_core::{DeviceLibraries, Library};

/// 单份来源的整理：先核对来源，再取这个图库的可写句柄。
pub(crate) fn write_source<T>(
    workspace: &mut Workspace,
    device: &mut DeviceLibraries,
    catalog: &mut TagCatalog,
    target: &WorkspaceSourceTarget,
    safe: bool,
    action: impl FnOnce(&Library) -> Result<T, kinshoko_core::library::Error>,
) -> Result<T, CatalogError> {
    workspace.read_source(device, catalog, target, safe)?;
    let writer = device
        .write(&target.library_id)
        .map_err(|e| CatalogError::Command(Box::new(e.into())))?;
    workspace.write_sources_with(
        device,
        catalog,
        std::slice::from_ref(target),
        safe,
        &writer,
        |library, _| action(library),
    )
}

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
    write_source(
        &mut workspace,
        &mut device,
        &mut catalog,
        &target,
        true,
        |library| {
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
        },
    )
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
    let error = write_source(
        &mut workspace,
        &mut device,
        &mut catalog,
        &changed,
        true,
        |library| library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete]),
    )
    .unwrap_err();
    assert!(error.to_string().contains("来源"));
    assert_eq!(b.image(&target.image_id).unwrap().deleted_at, None);
    write_source(
        &mut workspace,
        &mut device,
        &mut catalog,
        &target,
        true,
        |library| library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete]),
    )
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
        write_source(
            &mut workspace,
            &mut device,
            &mut catalog,
            &target,
            true,
            |l| l.edit(std::slice::from_ref(&bid), &[ImageEdit::Delete])
        )
        .is_err()
    );
    assert_eq!(b.image(&bid).unwrap().deleted_at, None);
    let b_root = b.info().root.clone();
    drop(b);
    // 长期只读句柄（#313）握着时 Windows 上改不了名：模拟断开前先放掉，同应用壳登记变化时。
    workspace.release_readers();
    std::fs::rename(&b_root, temp.path().join("disconnected-B")).unwrap();
    let error = write_source(
        &mut workspace,
        &mut device,
        &mut catalog,
        &target,
        false,
        |l| l.edit(std::slice::from_ref(&bid), &[ImageEdit::Delete]),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("暂时不可用"));
    assert_eq!(
        a.image(&aid).unwrap_err().to_string(),
        "资料库中没有这张参考图"
    );
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
        .write_sources_with(
            &device,
            &mut catalog,
            std::slice::from_ref(&target),
            true,
            &a,
            |library, _| library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete]),
        )
        .unwrap_err();
    assert!(error.to_string().contains("来源"), "{error}");
    assert_eq!(b.image(&target.image_id).unwrap().deleted_at, None);

    let writer = match device.organize(&b.info().id).unwrap() {
        kinshoko_core::WriterAccess::Ready { library, .. } => library,
        kinshoko_core::WriterAccess::Waiting(_) => panic!("不应等待"),
    };
    workspace
        .write_sources_with(
            &device,
            &mut catalog,
            std::slice::from_ref(&target),
            true,
            &writer,
            |library, _| {
                assert!(std::ptr::eq(library, &*writer), "就用给的那个句柄");
                library.edit(std::slice::from_ref(&target.image_id), &[ImageEdit::Delete])
            },
        )
        .unwrap();
    assert!(b.image(&target.image_id).unwrap().deleted_at.is_some());
    assert_eq!(a.image(&source_in(&card, &a)).unwrap().deleted_at, None);
}
