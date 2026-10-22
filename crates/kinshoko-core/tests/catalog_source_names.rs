//! 统一标签目录里的来源名称只来自看得见的映射（#217，ADR-0012）。

#[path = "support/eagle.rs"]
#[allow(dead_code)]
mod eagle;

use std::collections::BTreeMap;
use std::path::Path;

use kinshoko_core::DeviceLibraries;
use kinshoko_core::library::{
    ContentRating, ExternalVocabulary, ImageEdit, ImportSource, Library, LocalizedName,
    TagTranslation, TagTranslations,
};
use kinshoko_core::tag_catalog::TagCatalog;
use serde_json::json;

/// 每个标签一张图，颜色从 `color` 起各不相同。
fn import_eagle(library: &Library, dir: &Path, tags: &[&str], color: u8) -> Vec<String> {
    let mut fixture = eagle::build(&dir.join("主库.library"), "4.0.0", tags.len());
    for (i, tag) in tags.iter().enumerate() {
        image::RgbaImage::from_pixel(4, 3, image::Rgba([color + i as u8, 34, 56, 255]))
            .save(fixture.original(i))
            .unwrap();
        fixture.items[i]["tags"] = json!([tag]);
        fixture.items[i]["isDeleted"] = json!(false);
        fixture.items[i]["size"] = json!(std::fs::metadata(fixture.original(i)).unwrap().len());
        fixture.save_item(i);
    }
    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait()
        .items
        .iter()
        .map(|item| item.outcome.image_id().unwrap().to_owned())
        .collect()
}

fn vocabulary() -> ExternalVocabulary {
    ExternalVocabulary::new(
        ["blue_eyes".to_owned()],
        &TagTranslations {
            entries: vec![TagTranslation {
                external: "blue_eyes".into(),
                names: BTreeMap::from([("zh-CN".to_owned(), "蓝瞳".to_owned())]),
                aliases: Vec::new(),
            }],
        },
    )
}

fn map_only_tag(library: &Library) {
    let tag = library.vocabulary().unwrap().tags[0].id.clone();
    library
        .map_tag_external(&tag, "blue_eyes", &vocabulary())
        .unwrap();
}

#[test]
fn source_names_of_a_tag_hidden_by_safe_mode_stay_out_of_the_visible_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let public = device.create(&dir.path().join("public"), "A").unwrap();
    let adult = device.create(&dir.path().join("adult"), "B").unwrap();
    import_eagle(&public, &dir.path().join("a"), &["あおいめ"], 12);
    let sealed = import_eagle(&adult, &dir.path().join("b"), &["あおめ"], 92).remove(0);
    map_only_tag(&public);
    map_only_tag(&adult);
    adult.set_safe_mode(false);
    adult
        .edit(
            &[sealed],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    adult.set_safe_mode(true);
    let mut catalog = TagCatalog::open(&app).unwrap();

    let full = catalog.inspect_libraries(&device, false).unwrap();
    let safe = catalog.inspect_libraries(&device, true).unwrap();

    let names = |tags: &[kinshoko_core::tag_catalog::CatalogTag]| {
        tags.iter()
            .flat_map(|tag| tag.names.iter().chain(&tag.source_names))
            .map(|name| name.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(full.catalog.tags.len(), 1, "both map to blue_eyes");
    assert!(names(&full.catalog.tags).contains(&"あおめ".to_owned()));
    let visible = names(&safe.catalog.tags);
    assert!(visible.contains(&"あおいめ".to_owned()));
    assert!(
        !visible.contains(&"あおめ".to_owned()),
        "a sealed tag's source name leaked: {visible:?}"
    );
}

/// 已同步进目录的 Eagle 标签之后并入另一个标签：它在目录里的名称偏好跟到留下的标签上。
#[test]
fn a_merged_tag_hands_its_catalog_name_preference_to_the_tag_it_joined() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("lib"), "A").unwrap();
    import_eagle(&library, &dir.path().join("a"), &["あおいめ", "あおめ"], 12);
    let tags = library.vocabulary().unwrap().tags;
    let first = tags
        .iter()
        .find(|tag| tag.source_names[0].name == "あおいめ")
        .unwrap();
    let later = tags
        .iter()
        .find(|tag| tag.id != first.id)
        .unwrap()
        .id
        .clone();
    library
        .map_tag_external(&first.id, "blue_eyes", &vocabulary())
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let synced = catalog.synchronize(&library).unwrap();
    let old = synced
        .mappings
        .iter()
        .find(|mapping| mapping.local_tag_id == later)
        .unwrap()
        .catalog_id
        .clone();
    let preference = LocalizedName {
        lang: "ja".into(),
        name: "青い目".into(),
    };
    catalog.set_name_preference(&old, &preference).unwrap();

    library
        .map_tag_external(&later, "blue_eyes", &vocabulary())
        .unwrap();
    let inspection = catalog.synchronize(&library).unwrap();

    assert_eq!(inspection.mappings.len(), 1);
    let tag = inspection
        .tags
        .iter()
        .find(|tag| tag.id == inspection.mappings[0].catalog_id)
        .unwrap();
    assert_eq!(tag.name_preferences, [preference]);
}
