//! 整理与改标签（#425）：按（资料库，图）寻址，写之前按全部来源复核这些图此刻可见；给图挑标签时
//! 候选的封印同样按全部来源算。

use image::{Rgba, RgbaImage};
use kinshoko_core::approx::BuiltinApproxTable;
use kinshoko_core::library::{
    ContentRating, Error, ImageEdit, ImportSource, SafeMode, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::safe_mode::SafeModeState;
use kinshoko_core::tag_catalog::{CatalogError, TagCatalog};
use kinshoko_core::workspace::Workspace;
use kinshoko_core::{DeviceLibraries, Library, WriterAccess};
use std::sync::Arc;

struct Fixture {
    dir: tempfile::TempDir,
    device: DeviceLibraries,
    catalog: TagCatalog,
    workspace: Workspace,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        Self {
            device: DeviceLibraries::open(&app).unwrap(),
            catalog: TagCatalog::open(&app).unwrap(),
            workspace: Workspace::open(&app).unwrap(),
            dir,
        }
    }

    fn library(&mut self, name: &str) -> Arc<Library> {
        let root = self.dir.path().join(name);
        self.device.create(&root, name).unwrap()
    }

    fn import(&self, library: &Library, red: u8) -> String {
        let path = self.dir.path().join(format!("{red}.png"));
        RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
            .save(&path)
            .unwrap();
        library
            .import(ImportSource { paths: vec![path] })
            .wait()
            .items[0]
            .outcome
            .image_id()
            .unwrap()
            .to_owned()
    }

    /// 和应用壳一样，按需把可写句柄切到这个资料库。
    fn writer(&mut self, library: &str) -> Arc<Library> {
        match self.device.organize(library).unwrap() {
            WriterAccess::Ready { library, .. } => library,
            WriterAccess::Waiting(_) => panic!("不应等待"),
        }
    }

    fn note(
        &mut self,
        safe: &SafeModeState,
        writer: &Library,
        ids: &[String],
        text: &str,
    ) -> Result<(), CatalogError> {
        let (w, d, c) = (&mut self.workspace, &self.device, &mut self.catalog);
        w.write_visible_images(d, c, safe, writer, ids, |library| {
            library
                .edit(
                    ids,
                    &[ImageEdit::SetNote {
                        text: text.to_owned(),
                    }],
                )
                .map(|_| ())
        })
    }

    fn candidate_names(&mut self, library: &str, safe: bool) -> Vec<String> {
        let (w, d, c) = (&mut self.workspace, &self.device, &mut self.catalog);
        w.library_candidates(
            d,
            c,
            library,
            "姿势",
            "zh-CN",
            8,
            safe,
            &BuiltinApproxTable::default(),
        )
        .unwrap()
        .into_iter()
        .map(|candidate| candidate.tag.name)
        .collect()
    }
}

fn safe_mode(on: bool) -> SafeModeState {
    SafeModeState::new(SafeMode::new(on, Default::default()))
}

fn rate(library: &Library, id: &str, rating: ContentRating) {
    library.set_safe_mode(false);
    library
        .edit(&[id.to_owned()], &[ImageEdit::SetRating { rating }])
        .unwrap();
}

fn tag(library: &Library, id: &str, name: &str) {
    library
        .edit_tags(
            &[id.to_owned()],
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: name.into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
}

fn assert_unknown_image(result: Result<(), CatalogError>) {
    assert!(
        matches!(result, Err(CatalogError::Library(Error::UnknownImage))),
        "{result:?}"
    );
}

#[test]
fn a_write_changes_only_the_addressed_copy_on_the_given_writer() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let in_a = f.import(&a, 10);
    let b = f.library("b");
    let in_b = f.import(&b, 10);
    let a_id = a.info().id.clone();
    let writer = f.writer(&a_id);

    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    w.write_visible_images(
        d,
        c,
        &safe_mode(true),
        &writer,
        std::slice::from_ref(&in_a),
        |library| {
            assert!(std::ptr::eq(library, &*writer), "就用给的那个句柄");
            library.edit(
                std::slice::from_ref(&in_a),
                &[ImageEdit::SetNote {
                    text: "A 的".into(),
                }],
            )
        },
    )
    .unwrap();

    assert_eq!(a.image(&in_a).unwrap().note.manual.as_deref(), Some("A 的"));
    assert_eq!(b.image(&in_b).unwrap().note.manual, None);
}

#[test]
fn several_images_of_one_library_are_written_together() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let ids = [f.import(&a, 10), f.import(&a, 20)];

    let writer = f.writer(&a.info().id.clone());
    f.note(&safe_mode(true), &writer, &ids, "两张").unwrap();

    for id in &ids {
        assert_eq!(a.image(id).unwrap().note.manual.as_deref(), Some("两张"));
    }
}

#[test]
fn one_unknown_image_stops_the_whole_write() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let writer = f.writer(&a.info().id.clone());

    assert_unknown_image(f.note(
        &safe_mode(true),
        &writer,
        &[image.clone(), "no-such-image".to_owned()],
        "不写",
    ));
    assert_eq!(a.image(&image).unwrap().note.manual, None);
}

#[test]
fn a_sealed_image_is_not_written_until_safe_mode_is_off() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    rate(&a, &image, ContentRating::Explicit);
    let ids = [image.clone()];
    let writer = f.writer(&a.info().id.clone());

    assert_unknown_image(f.note(&safe_mode(true), &writer, &ids, "不写"));
    a.set_safe_mode(false);
    assert_eq!(a.image(&image).unwrap().note.manual, None);

    f.note(&safe_mode(false), &writer, &ids, "写").unwrap();
    assert_eq!(a.image(&image).unwrap().note.manual.as_deref(), Some("写"));
}

#[test]
fn a_copy_rated_adult_in_another_library_stops_the_write() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let copy = f.import(&a, 10);
    let b = f.library("b");
    let rated = f.import(&b, 10);
    rate(&b, &rated, ContentRating::Explicit);
    let writer = f.writer(&a.info().id.clone());

    assert_unknown_image(f.note(
        &safe_mode(true),
        &writer,
        std::slice::from_ref(&copy),
        "不写",
    ));
    assert_eq!(a.image(&copy).unwrap().note.manual, None);
}

#[test]
fn an_image_in_the_trash_can_be_restored() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    a.edit(std::slice::from_ref(&image), &[ImageEdit::Delete])
        .unwrap();
    let writer = f.writer(&a.info().id.clone());

    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    w.write_visible_images(
        d,
        c,
        &safe_mode(true),
        &writer,
        std::slice::from_ref(&image),
        |library| library.edit(std::slice::from_ref(&image), &[ImageEdit::Restore]),
    )
    .unwrap();
    assert_eq!(a.image(&image).unwrap().deleted_at, None);
}

#[test]
fn the_rating_that_seals_an_image_is_still_saved() {
    // 普通面板靠这一点把选择收起：写之前可见就写，写完之后才被封印。
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let writer = f.writer(&a.info().id.clone());

    let safe = safe_mode(true);
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    w.write_visible_images(
        d,
        c,
        &safe,
        &writer,
        std::slice::from_ref(&image),
        |library| {
            library.edit(
                std::slice::from_ref(&image),
                &[ImageEdit::SetRating {
                    rating: ContentRating::Explicit,
                }],
            )
        },
    )
    .unwrap();

    assert!(matches!(
        w.image_detail(d, c, &safe, &writer.info().id, &image),
        Err(CatalogError::Library(Error::UnknownImage))
    ));
}

#[test]
fn candidates_hide_tags_used_only_on_copies_sealed_by_another_library() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let hidden = f.import(&a, 10);
    tag(&a, &hidden, "姿势隐藏");
    let shown = f.import(&a, 20);
    tag(&a, &shown, "姿势可见");
    let both = f.import(&a, 30);
    tag(&a, &hidden, "姿势共用");
    tag(&a, &both, "姿势共用");
    let b = f.library("b");
    let rated = f.import(&b, 10);
    rate(&b, &rated, ContentRating::Explicit);
    let id = a.info().id.clone();

    let names = f.candidate_names(&id, true);
    assert!(names.contains(&"姿势可见".to_owned()), "{names:?}");
    assert!(names.contains(&"姿势共用".to_owned()), "{names:?}");
    assert!(!names.contains(&"姿势隐藏".to_owned()), "{names:?}");

    assert!(
        f.candidate_names(&id, false)
            .contains(&"姿势隐藏".to_owned())
    );
}

#[test]
fn candidates_use_the_tag_ids_of_the_addressed_library_and_count_what_is_visible() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    tag(&a, &image, "姿势");
    let trashed = f.import(&a, 20);
    tag(&a, &trashed, "姿势");
    a.edit(std::slice::from_ref(&trashed), &[ImageEdit::Delete])
        .unwrap();
    let local = a.vocabulary().unwrap().tags[0].id.clone();
    let id = a.info().id.clone();

    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    let candidates = w
        .library_candidates(
            d,
            c,
            &id,
            "姿势",
            "zh-CN",
            8,
            true,
            &BuiltinApproxTable::default(),
        )
        .unwrap();
    assert_eq!(candidates[0].tag.id, local);
    assert_eq!(candidates[0].count, 1);
}

#[test]
fn candidates_for_a_removed_library_are_an_error() {
    let mut f = Fixture::new();
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    assert!(
        w.library_candidates(
            d,
            c,
            "no-such-library",
            "姿势",
            "zh-CN",
            8,
            true,
            &BuiltinApproxTable::default(),
        )
        .is_err()
    );
}
