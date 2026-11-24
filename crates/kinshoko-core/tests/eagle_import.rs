//! Eagle 首次迁入（#57）：只通过核心 crate 的公开接口验证，源库始终只读。

#[path = "eagle_import_duplicates.rs"]
mod duplicates;
#[path = "support/eagle.rs"]
mod eagle;
#[path = "eagle_import_retry.rs"]
mod retry;

use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, EagleDiscoveryMethod, EagleDiscoveryOptions, ImageEdit, LibraryEvent,
    TagEdit, TagNamespace, TagRef, discover_eagle_libraries,
};
use kinshoko_core::library::{ImportOutcome, ImportSource};
use sha2::{Digest, Sha256};

#[test]
fn first_import_reads_items_not_thumbnails_or_mtime_and_preserves_original_bytes() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 1);
        let original = std::fs::read(fixture.original(0)).unwrap();
        let metadata = std::fs::read(fixture.item_dir(0).join("metadata.json")).unwrap();
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();

        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();

        assert_eq!(report.items.len(), 1, "只枚举 images 下的条目：{report:?}");
        assert!(report.from_eagle, "通用导入报告必须标明识别到的 Eagle 来源");
        let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
            panic!("Eagle {version} 应成功迁入：{report:?}");
        };
        assert_eq!(
            Sha256::digest(std::fs::read(library.original_path(image_id).unwrap()).unwrap()),
            Sha256::digest(&original)
        );
        assert_eq!(std::fs::read(fixture.original(0)).unwrap(), original);
        assert_eq!(
            std::fs::read(fixture.item_dir(0).join("metadata.json")).unwrap(),
            metadata
        );
    }
}

#[test]
fn eagle_import_uses_decoded_display_dimensions_and_keeps_metadata_verbatim() {
    use image::ImageEncoder;

    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = eagle::build(&dir.path().join("主库.library"), version, 2);
        fixture.items[0]["width"] = serde_json::json!(900);
        fixture.items[0]["height"] = serde_json::json!(300);
        fixture.save_item(0);

        // 原文件为 48 × 24，EXIF 方向 6 表示顺时针旋转 90°。
        fixture.items[1]["ext"] = serde_json::json!("jpg");
        fixture.items[1]["width"] = serde_json::json!(48);
        fixture.items[1]["height"] = serde_json::json!(24);
        let pixels = image::RgbImage::new(48, 24);
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut bytes);
        encoder
            .set_exif_metadata(vec![
                b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0,
                0,
            ])
            .unwrap();
        encoder
            .write_image(pixels.as_raw(), 48, 24, image::ExtendedColorType::Rgb8)
            .unwrap();
        std::fs::write(fixture.original(1), &bytes).unwrap();
        fixture.items[1]["size"] = serde_json::json!(bytes.len());
        fixture.save_item(1);

        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        assert!(
            report
                .items
                .iter()
                .all(|item| matches!(item.outcome, ImportOutcome::Imported { .. })),
            "{report:?}"
        );
        let sources = library.eagle_sources().unwrap();
        for (i, expected) in [(20, 20), (24, 48)].into_iter().enumerate() {
            let binding = &sources[0].bindings[i];
            let detail = library.image(&binding.image_id).unwrap();
            assert_eq!((detail.width, detail.height), expected);
            assert_eq!(
                binding.raw_item_json,
                std::fs::read_to_string(fixture.item_dir(i).join("metadata.json")).unwrap()
            );
        }
        let page = library
            .browse(&BrowseQuery {
                scope: BrowseScope::All,
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                thumbnail_px: 256,
            })
            .unwrap();
        for (i, expected) in [(20, 20), (24, 48)].into_iter().enumerate() {
            let card = page
                .cards
                .iter()
                .find(|card| card.id == sources[0].bindings[i].image_id)
                .unwrap();
            assert_eq!((card.width, card.height), expected);
        }
    }
}

#[test]
fn all_eagle_fields_folders_tags_notes_links_and_region_comments_survive_reopen() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 4);
        let root = dir.path().join("kinshoko");
        let library = Library::create(&root, "参考").unwrap();
        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        assert!(
            report
                .items
                .iter()
                .all(|item| matches!(item.outcome, ImportOutcome::Imported { .. })),
            "{report:?}"
        );
        let sources = library.eagle_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0].raw_library_json,
            std::fs::read_to_string(fixture.root.join("metadata.json")).unwrap()
        );
        assert_eq!(sources[0].bindings.len(), 4);
        for (i, binding) in sources[0].bindings.iter().enumerate() {
            assert_eq!(
                binding.external_id,
                fixture.items[i]["id"].as_str().unwrap()
            );
            assert_eq!(
                binding.raw_item_json,
                std::fs::read_to_string(fixture.item_dir(i).join("metadata.json")).unwrap()
            );
            let detail = library.image(&binding.image_id).unwrap();
            assert_eq!(detail.original_name, format!("图{i:04}"));
            assert_eq!(detail.collected_at, 1756571097667_i64 + i as i64);
            assert_eq!(detail.source_links, [format!("https://example.com/{i}")]);
            assert_eq!(detail.note.sources[0].text, format!("看高光{i}"));
            assert_eq!(
                detail
                    .folders
                    .iter()
                    .map(|f| f.name.as_str())
                    .collect::<Vec<_>>(),
                if i % 3 == 2 {
                    vec![]
                } else {
                    vec!["发型参考", "女"]
                }
            );
            let mut names: Vec<_> = library
                .image_tags(&binding.image_id, "zh-CN")
                .unwrap()
                .tags
                .into_iter()
                .map(|t| t.tag.name)
                .collect();
            names.sort();
            assert_eq!(names, [format!("标签{i}"), "蓝发".to_owned()]);
            if i == 3 {
                assert_eq!(binding.region_notes[0].basis, "eagle-raw-unverified");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&binding.region_notes[0].raw_json)
                        .unwrap(),
                    fixture.items[i]["comments"][0]
                );
            }
        }
        let sidebar = library.sidebar().unwrap();
        assert_eq!(
            sidebar
                .folders
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["角色", "发型参考", "空文件夹"]
        );
        assert_eq!(sidebar.folders[0].children[0].name, "女");
        drop(library);
        let reopened = Library::open(&root).unwrap();
        assert_eq!(reopened.eagle_sources().unwrap(), sources);
    }
}

#[test]
fn discovery_finds_settings_history_and_counts_the_images_directory() {
    let dir = tempfile::tempdir().unwrap();
    let large = eagle::build(&dir.path().join("主库.library"), "1.8.2", 150);
    let small = eagle::build(&dir.path().join("第二个库.library"), "4.0.0", 20);
    let app_data = dir.path().join("appdata");
    std::fs::create_dir_all(app_data.join("Eagle")).unwrap();
    eagle::write_json(
        &app_data.join("Eagle/Settings"),
        &serde_json::json!({
            "libraryHistory": [small.root, large.root, large.root, dir.path().join("不存在.library")]
        }),
    );

    let found = discover_eagle_libraries(&EagleDiscoveryOptions {
        app_data,
        api_address: None,
        scan_roots: Vec::new(),
        ..Default::default()
    });

    assert_eq!(found.len(), 2);
    assert_eq!(found[0].name, "主库");
    assert_eq!(found[0].items, 150);
    assert_eq!(found[0].version.as_deref(), Some("1.8.2"));
    assert_eq!(found[1].items, 20);
    assert_eq!(found[1].version.as_deref(), Some("4.0.0"));
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
