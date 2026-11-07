//! #484 预置标签分组：全局还没有任何分组时只预置一次“发色”“瞳色”。
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    FactSource, ImportSource, SourceTag, TagNamespace, TagRef, TagTranslations,
};
use kinshoko_core::tag_catalog::{CatalogGroupEdit, TagCatalog};
use kinshoko_core::workspace::Workspace;
use kinshoko_core::{DeviceLibraries, Library};
use std::path::Path;

fn tagged_image(library: &Library, root: &Path, external: &str) {
    let path = root.join(format!("{external}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([9, 34, 56, 255]))
        .save(&path)
        .unwrap();
    let id = library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    library
        .replace_source_tags(
            &FactSource::model("test"),
            &id,
            &[SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: external.into(),
                },
                score: None,
            }],
        )
        .unwrap();
}

fn open(app: &Path) -> (TagCatalog, Workspace) {
    let mut catalog = TagCatalog::open(app).unwrap();
    catalog
        .install_name_defaults(TagTranslations::bundled())
        .unwrap();
    (catalog, Workspace::open(app).unwrap())
}

#[test]
fn a_fresh_install_has_hair_and_eye_groups_that_join_later_tagged_images() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let (mut catalog, mut workspace) = open(&app);
    // 还没有任何资料库时，两组已经在，标签可点。
    let groups = workspace
        .tag_groups(&device, &mut catalog, "", "zh-CN", true)
        .unwrap();
    assert_eq!(
        groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["发色", "瞳色"]
    );
    assert!(groups.iter().all(|g| !g.tags.is_empty()));
    let blue = |groups: &[kinshoko_core::library::TagGroupView], i: usize| {
        groups[i]
            .tags
            .iter()
            .find(|t| t.tag.name == if i == 0 { "蓝发" } else { "蓝瞳" })
            .cloned()
            .expect("默认名称")
    };
    let blue_hair = blue(&groups, 0);
    assert_eq!(blue_hair.count, 0);

    // 之后导入带 blue_hair 的图：同一个统一身份，点这个标签就查到那张图。
    let lib = device.create(&dir.path().join("lib"), "库").unwrap();
    tagged_image(&lib, dir.path(), "blue_hair");
    let groups = workspace
        .tag_groups(&device, &mut catalog, &lib.info().id, "zh-CN", true)
        .unwrap();
    assert_eq!(groups.len(), 2, "不会重复预置");
    let after = blue(&groups, 0);
    assert_eq!(after.tag.id, blue_hair.tag.id);
    assert_eq!(after.count, 1);
}

#[test]
fn a_deleted_preset_group_stays_deleted_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let device = DeviceLibraries::open(&app).unwrap();
    let (mut catalog, mut workspace) = open(&app);
    let groups = workspace
        .shared_tag_groups(&device, &mut catalog, "zh-CN", true)
        .unwrap();
    for g in &groups {
        workspace
            .edit_group(
                &device,
                &mut catalog,
                &CatalogGroupEdit::Delete {
                    group_id: g.id.clone(),
                },
                true,
            )
            .unwrap();
    }
    drop((catalog, workspace));
    let (mut catalog, mut workspace) = open(&app);
    assert!(
        workspace
            .tag_groups(&device, &mut catalog, "", "zh-CN", true)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn artists_who_already_have_a_group_do_not_gain_the_presets() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let device = DeviceLibraries::open(&app).unwrap();
    {
        let mut catalog = TagCatalog::open(&app).unwrap();
        catalog.create_group("我的", None).unwrap();
    }
    let (mut catalog, mut workspace) = open(&app);
    let groups = workspace
        .tag_groups(&device, &mut catalog, "", "zh-CN", true)
        .unwrap();
    assert_eq!(
        groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["我的"]
    );
}
