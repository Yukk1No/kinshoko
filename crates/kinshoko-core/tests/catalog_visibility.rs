use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    ContentRating, ImageEdit, ImportSource, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};
use kinshoko_core::{DeviceLibraries, Library};

fn import(library: &Library, path: &std::path::Path) -> String {
    library
        .import(ImportSource {
            paths: vec![path.into()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned()
}

fn tag(library: &Library, image: &str, name: &str) {
    library
        .edit_tags(
            &[image.into()],
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: name.into(),
                    lang: "en".into(),
                },
            }],
        )
        .unwrap();
}

#[test]
fn ordinary_name_settings_do_not_expose_tags_from_globally_vetoed_copies() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let adult_library = device
        .create(&dir.path().join("adult-source"), "A")
        .unwrap();
    let other_library = device
        .create(&dir.path().join("other-source"), "B")
        .unwrap();
    let same = dir.path().join("same.png");
    let public = dir.path().join("public.png");
    RgbaImage::from_pixel(4, 3, Rgba([12, 34, 56, 255]))
        .save(&same)
        .unwrap();
    RgbaImage::from_pixel(4, 3, Rgba([92, 34, 56, 255]))
        .save(&public)
        .unwrap();
    let adult_image = import(&adult_library, &same);
    let unknown_copy = import(&other_library, &same);
    let public_image = import(&other_library, &public);
    tag(&other_library, &unknown_copy, "sealed-copy-only-tag");
    tag(&other_library, &public_image, "legitimate-public-tag");
    adult_library.set_safe_mode(false);
    adult_library
        .edit(
            &[adult_image],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    adult_library.set_safe_mode(true);

    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                scope: WorkspaceScope::All,
                conditions: Default::default(),
                cursor: None,
                limit: 20,
                thumbnail_px: 240,
            },
            true,
        )
        .unwrap();
    assert_eq!(
        page.total, 1,
        "the shared bytes are already known to be vetoed"
    );
    let safe = catalog.inspect_libraries(&device, true).unwrap();
    let visible: Vec<_> = safe
        .catalog
        .tags
        .iter()
        .flat_map(|tag| &tag.names)
        .map(|name| name.name.as_str())
        .collect();
    assert!(visible.contains(&"legitimate-public-tag"));
    assert!(
        !visible.contains(&"sealed-copy-only-tag"),
        "ordinary name settings exposed a tag of a globally vetoed image: {visible:?}"
    );
    assert!(adult_library.safe_mode());
    assert!(other_library.safe_mode());
}

#[test]
fn names_and_groups_share_online_and_known_offline_veto_without_losing_unused_definitions() {
    use kinshoko_core::tag_catalog::CatalogGroupEdit;
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let same = dir.path().join("same.png");
    let public = dir.path().join("public.png");
    RgbaImage::from_pixel(4, 3, Rgba([11, 22, 33, 255]))
        .save(&same)
        .unwrap();
    RgbaImage::from_pixel(4, 3, Rgba([44, 22, 33, 255]))
        .save(&public)
        .unwrap();
    let ai = import(&a, &same);
    let bi = import(&b, &same);
    let visible = import(&b, &public);
    tag(&b, &bi, "sealed-only");
    tag(&b, &bi, "still-visible");
    tag(&b, &visible, "still-visible");
    tag(&b, &visible, "unused-definition");
    let unused = b
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.names.iter().any(|n| n.name == "unused-definition"))
        .unwrap()
        .id;
    b.edit_tags(
        std::slice::from_ref(&visible),
        &[TagEdit::Clear {
            tag: TagRef::Id { id: unused.clone() },
        }],
    )
    .unwrap();
    a.set_safe_mode(false);
    a.edit(
        &[ai],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    a.set_safe_mode(true);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let full = catalog.inspect_libraries(&device, false).unwrap();
    let ids = full
        .catalog
        .tags
        .iter()
        .map(|t| t.id.clone())
        .collect::<Vec<_>>();
    let group = catalog.create_group("all definitions", None).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    workspace
        .edit_group(
            &device,
            &mut catalog,
            &CatalogGroupEdit::AddMembers {
                group_id: group,
                tag_ids: ids,
            },
            false,
        )
        .unwrap();
    let raw = catalog.inspect().unwrap();
    let check = |catalog: &mut TagCatalog, workspace: &mut Workspace, device: &DeviceLibraries| {
        let safe = catalog.inspect_libraries(device, true).unwrap();
        let names = safe
            .catalog
            .tags
            .iter()
            .flat_map(|t| &t.names)
            .map(|n| n.name.as_str())
            .collect::<Vec<_>>();
        assert!(
            !names.contains(&"sealed-only"),
            "inspection must apply the all-source veto: {names:?}"
        );
        assert!(
            names.contains(&"still-visible"),
            "a tag also used by a visible image is retained"
        );
        assert!(
            names.contains(&"unused-definition"),
            "unused definitions remain manageable"
        );
        let plan = catalog.plan_name_migration(&safe.catalog).unwrap();
        assert!(
            !serde_json::to_string(&plan)
                .unwrap()
                .contains("sealed-only")
        );
        let groups = workspace
            .shared_tag_groups(device, catalog, "en", true)
            .unwrap();
        let members = groups[0]
            .tags
            .iter()
            .map(|t| t.tag.name.as_str())
            .collect::<Vec<_>>();
        assert!(!members.contains(&"sealed-only"));
        assert!(members.contains(&"still-visible"));
        assert!(members.contains(&"unused-definition"));
        assert_eq!(
            groups[0]
                .tags
                .iter()
                .find(|t| t.tag.name == "still-visible")
                .unwrap()
                .count,
            1
        );
        assert_eq!(
            groups[0]
                .tags
                .iter()
                .find(|t| t.tag.name == "unused-definition")
                .unwrap()
                .count,
            0
        );
    };
    check(&mut catalog, &mut workspace, &device);
    assert_eq!(
        catalog.inspect().unwrap(),
        raw,
        "filtering must not delete original catalog definitions"
    );
    let adult_id = a.info().id.clone();
    drop(a);
    drop(workspace);
    drop(catalog);
    drop(device);
    std::fs::rename(dir.path().join("a"), dir.path().join("offline-a")).unwrap();
    let mut device = DeviceLibraries::open(&app).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    check(&mut catalog, &mut workspace, &device);
    assert_eq!(
        catalog.inspect().unwrap(),
        raw,
        "known offline safety only changes the view"
    );
    device.unregister(&adult_id).unwrap();
    let released = catalog.inspect_libraries(&device, true).unwrap();
    assert!(
        released
            .catalog
            .tags
            .iter()
            .flat_map(|t| &t.names)
            .any(|n| n.name == "sealed-only"),
        "explicit unregister forgets the former source veto"
    );
    assert!(b.safe_mode());
}
