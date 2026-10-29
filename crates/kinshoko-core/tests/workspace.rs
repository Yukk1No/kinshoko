use image::{Rgba, RgbaImage};
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{FactSource, ImportSource, SourceTag, TagNamespace, TagRef};
use kinshoko_core::search::{ConditionInput, SearchInput, TermInput};
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
fn tag(library: &Library, id: &str, names: &[&str]) {
    library
        .replace_source_tags(
            &FactSource::model("test"),
            id,
            &names
                .iter()
                .map(|name| SourceTag {
                    tag: TagRef::External {
                        namespace: TagNamespace::General,
                        name: (*name).into(),
                    },
                    score: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
}
#[test]
fn each_source_must_match_all_conditions_before_identical_bytes_are_aggregated() {
    let dir = tempfile::tempdir().unwrap();
    let mut device = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let file = dir.path().join("same.png");
    RgbaImage::from_pixel(4, 3, Rgba([12, 34, 56, 255]))
        .save(&file)
        .unwrap();
    let ai = import(&a, &file);
    let bi = import(&b, &file);
    tag(&a, &ai, &["blue_eyes"]);
    tag(&b, &bi, &["short_hair"]);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let mut workspace = Workspace::open(&dir.path().join("app")).unwrap();
    let builtin = BuiltinApproxTable::default();
    let all = WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 1,
        thumbnail_px: 240,
    };
    let page = workspace.browse(&device, &mut catalog, &all, true).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.cards[0].sources.len(), 2);
    assert_eq!(device.current().unwrap().info().id, b.info().id);
    let search = SearchInput {
        conditions: ["blue eyes", "short hair"]
            .iter()
            .map(|text| ConditionInput {
                any: vec![TermInput::Text {
                    text: (*text).into(),
                    dismissed: vec![],
                }],
                negate: false,
            })
            .collect(),
        exact: true,
    };
    let tree = workspace
        .resolve(&device, &mut catalog, &search, "en", true, &builtin)
        .unwrap();
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &WorkspaceQuery {
                    conditions: tree,
                    ..all.clone()
                },
                true
            )
            .unwrap()
            .total,
        0
    );
    tag(&a, &ai, &["blue_eyes", "short_hair"]);
    let tree = workspace
        .resolve(&device, &mut catalog, &search, "en", true, &builtin)
        .unwrap();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                conditions: tree,
                ..all
            },
            true,
        )
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.cards[0].sources.len(), 2);
    assert_eq!(
        page.cards[0].sources.iter().filter(|s| s.matches).count(),
        1
    );
}
use kinshoko_core::library::{ContentRating, ImageEdit, TagEdit};
use kinshoko_core::search::Condition;
use kinshoko_core::tag_catalog::CatalogCorrection;
fn query() -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::All,
        conditions: Default::default(),
        cursor: None,
        limit: 1,
        thumbnail_px: 240,
    }
}
fn files(dir: &std::path::Path, libraries: &[&Library], red: u8) -> Vec<String> {
    let path = dir.join(format!("{red}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
        .save(&path)
        .unwrap();
    libraries.iter().map(|l| import(l, &path)).collect()
}
#[test]
fn adult_in_nonmatching_out_of_scope_source_vetoes_cards_counts_and_candidates_without_changing_active_lens()
 {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let ids = files(dir.path(), &[&a, &b], 20);
    let unknown = files(dir.path(), &[&a], 40)[0].clone();
    tag(&a, &ids[0], &["private_blue"]);
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    b.set_safe_mode(true);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let builtin = BuiltinApproxTable::default();
    let q = WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: a.info().id.clone(),
            scope: Default::default(),
        },
        ..query()
    };
    let open = workspace.browse(&device, &mut catalog, &q, false).unwrap();
    assert_eq!(open.total, 2);
    assert!(b.safe_mode());
    assert!(
        b.image(&ids[1]).is_err(),
        "detached workspace reads must not release active library"
    );
    let page = workspace.browse(&device, &mut catalog, &q, true).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(
        page.cards[0].image_id, unknown,
        "unrated content remains visible"
    );
    assert!(
        workspace
            .candidates(&device, &mut catalog, "private", "en", 20, true, &builtin)
            .unwrap()
            .is_empty()
    );
    assert!(
        !workspace
            .contains(&device, &mut catalog, &a.info().id, &ids[0], true)
            .unwrap()
    );
    // 缩略图请求的核对（#123）与 contains 同一道否决；长期握着的提供方句柄不掩盖之后的变化（#313）。
    assert!(
        workspace
            .image_reader(&device, &mut catalog, &a.info().id, &ids[0], true)
            .is_err()
    );
    assert!(
        workspace
            .image_reader(&device, &mut catalog, &a.info().id, &ids[0], false)
            .is_ok()
    );
    assert!(
        workspace
            .image_reader(&device, &mut catalog, &a.info().id, &unknown, true)
            .is_ok()
    );
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::General,
        }],
    )
    .unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &q, true)
            .unwrap()
            .total,
        2
    );
    assert!(
        workspace
            .image_reader(&device, &mut catalog, &a.info().id, &ids[0], true)
            .is_ok(),
        "held provider readers still see the rating change"
    );
    assert_eq!(
        workspace
            .candidates(&device, &mut catalog, "private", "en", 20, true, &builtin)
            .unwrap()[0]
            .count,
        1
    );
}
#[test]
fn unavailable_known_adult_source_keeps_veto_after_restart_until_refresh_or_explicit_unregister() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let ids = files(dir.path(), &[&a, &b], 25);
    tag(&b, &ids[1], &["offline_secret"]);
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let b_id = b.info().id.clone();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        0
    );
    drop(a);
    drop(b);
    drop(device);
    drop(workspace);
    std::fs::rename(dir.path().join("b"), dir.path().join("offline-b")).unwrap();
    let mut device = DeviceLibraries::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let safe = workspace
        .browse(&device, &mut catalog, &query(), true)
        .unwrap();
    assert_eq!(safe.total, 0);
    assert_eq!(
        safe.status
            .libraries
            .iter()
            .filter(|l| l.unavailable.is_some())
            .count(),
        1
    );
    assert!(
        workspace
            .candidates(
                &device,
                &mut catalog,
                "offline",
                "en",
                20,
                false,
                &BuiltinApproxTable::default()
            )
            .unwrap()
            .is_empty(),
        "cached unavailable tags must never be search definitions"
    );
    let open = workspace
        .browse(&device, &mut catalog, &query(), false)
        .unwrap();
    assert_eq!(open.cards[0].sources.len(), 2);
    assert!(
        open.cards[0]
            .sources
            .iter()
            .any(|s| s.unavailable.is_some())
    );
    std::fs::rename(dir.path().join("offline-b"), dir.path().join("b")).unwrap();
    let b = Library::open(&dir.path().join("b")).unwrap();
    b.set_safe_mode(false);
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::General,
        }],
    )
    .unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        1
    );
    b.edit(
        &[ids[1].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        0
    );
    drop(b);
    // 长期只读句柄（#313）握着时 Windows 上改不了名：模拟断开前先放掉，同应用壳登记变化时。
    workspace.release_readers();
    std::fs::rename(dir.path().join("b"), dir.path().join("offline-b")).unwrap();
    device.unregister(&b_id).unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &query(), true)
            .unwrap()
            .total,
        1
    );
}

#[path = "workspace_queries.rs"]
mod queries;
