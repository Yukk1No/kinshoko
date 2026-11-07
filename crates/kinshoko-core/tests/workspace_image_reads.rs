//! 单图详情的读取（#424）：详情、标签都按（资料库，图）寻址，不切换任何句柄；
//! 可见性复核与安全模式封印在这一条路上，读之前和读之后各核对一次。

use image::{Rgba, RgbaImage};
use kinshoko_core::library::{ContentRating, Error, ImageEdit, ImportSource, SafeMode};
use kinshoko_core::safe_mode::SafeModeState;
use kinshoko_core::tag_catalog::{CatalogError, TagCatalog};
use kinshoko_core::workspace::Workspace;
use kinshoko_core::{DeviceLibraries, Library};

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

    fn library(&mut self, name: &str) -> std::sync::Arc<Library> {
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

    /// 两个读取都得到同一个结果：`Ok` 时都读到了这张图，`Err` 时都是这个错误。
    fn each_read(
        &mut self,
        safe: &SafeModeState,
        library: &str,
        image: &str,
    ) -> [Result<(), CatalogError>; 2] {
        let (w, d, c) = (&mut self.workspace, &self.device, &mut self.catalog);
        [
            w.image_detail(d, c, safe, library, image).map(|detail| {
                assert_eq!(detail.id, image);
            }),
            w.image_tags(d, c, safe, library, image, "zh-CN")
                .map(|tags| {
                    assert_eq!(tags.image.image_id, image);
                }),
        ]
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

fn assert_unknown_image(results: [Result<(), CatalogError>; 2]) {
    for result in results {
        assert!(
            matches!(result, Err(CatalogError::Library(Error::UnknownImage))),
            "{result:?}"
        );
    }
}

#[test]
fn reads_any_registered_library_without_switching_the_writer() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let folder = a.create_folder("人物", None).unwrap();
    a.edit(
        std::slice::from_ref(&image),
        &[ImageEdit::AddToFolder {
            folder_id: folder.clone(),
        }],
    )
    .unwrap();
    let a_id = a.info().id.clone();
    let b = f.library("b");
    let writer = f.device.current().unwrap().info().id.clone();
    assert_eq!(writer, b.info().id);

    let safe = safe_mode(true);
    for result in f.each_read(&safe, &a_id, &image) {
        result.unwrap();
    }
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    let detail = w.image_detail(d, c, &safe, &a_id, &image).unwrap();
    assert_eq!(detail.folders[0].id, folder);
    assert_eq!(f.device.current().unwrap().info().id, writer);
}

#[test]
fn an_image_in_the_trash_stays_readable() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    a.edit(std::slice::from_ref(&image), &[ImageEdit::Delete])
        .unwrap();
    let id = a.info().id.clone();

    let safe = safe_mode(true);
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    let detail = w.image_detail(d, c, &safe, &id, &image).unwrap();
    assert!(detail.deleted_at.is_some());
}

#[test]
fn a_sealed_image_answers_as_if_it_did_not_exist() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    rate(&a, &image, ContentRating::Explicit);
    let id = a.info().id.clone();

    assert_unknown_image(f.each_read(&safe_mode(true), &id, &image));
    for result in f.each_read(&safe_mode(false), &id, &image) {
        result.unwrap();
    }
}

#[test]
fn a_copy_rated_adult_in_another_library_seals_every_copy() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let copy = f.import(&a, 10);
    let b = f.library("b");
    let rated = f.import(&b, 10);
    rate(&b, &rated, ContentRating::Explicit);
    let id = a.info().id.clone();

    assert_unknown_image(f.each_read(&safe_mode(true), &id, &copy));
}

#[test]
fn a_removed_library_and_an_unknown_image_answer_as_missing() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let id = a.info().id.clone();
    let safe = safe_mode(true);

    assert_unknown_image(f.each_read(&safe, &id, "no-such-image"));
    assert_unknown_image(f.each_read(&safe, "no-such-library", &image));

    drop(a);
    f.device.unregister(&id).unwrap();
    assert_unknown_image(f.each_read(&safe, &id, &image));
}

#[test]
fn a_disconnected_library_reports_why_instead_of_a_missing_image() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let id = a.info().id.clone();
    let safe = safe_mode(true);
    // 先读一次，快照里记下这张图：断开之后仍认得它。
    for result in f.each_read(&safe, &id, &image) {
        result.unwrap();
    }
    let _ = f.library("b");
    drop(a);
    // 长期只读句柄握着时 Windows 上改不了名，同 `workspace_folders`。
    f.workspace.release_readers();
    let root = f.dir.path().join("a");
    std::fs::rename(&root, f.dir.path().join("disconnected")).unwrap();

    for result in f.each_read(&safe, &id, &image) {
        assert!(
            matches!(result, Err(CatalogError::Command(_))),
            "{result:?}"
        );
    }
}

#[test]
fn a_rating_that_seals_the_image_during_the_read_discards_the_result() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let id = a.info().id.clone();

    let safe = safe_mode(true);
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    let result = w.read_visible_image(d, c, &safe, &id, &image, |_, _, library| {
        let value = library.image(&image)?;
        rate(&a, &image, ContentRating::Explicit);
        Ok(value)
    });
    assert!(matches!(
        result,
        Err(CatalogError::Library(Error::UnknownImage))
    ));
}

#[test]
fn a_safe_mode_commit_during_the_read_discards_the_result() {
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let id = a.info().id.clone();

    // 重复设成同一值也算一次提交，同 `SafeModeState::still`。
    let safe = safe_mode(true);
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    let result = w.read_visible_image(d, c, &safe, &id, &image, |_, _, library| {
        let value = library.image(&image)?;
        safe.commit(|mode| mode.on = true);
        Ok(value)
    });
    assert!(matches!(
        result,
        Err(CatalogError::Library(Error::LensChanged))
    ));
}

#[test]
fn a_write_to_another_image_during_the_read_does_not_fail_the_read() {
    // 导入收尾、后台打标会一直推进修订号：只要这张图仍可见，读取就有效。
    let mut f = Fixture::new();
    let a = f.library("a");
    let image = f.import(&a, 10);
    let other = f.import(&a, 20);
    let id = a.info().id.clone();

    let safe = safe_mode(true);
    let (w, d, c) = (&mut f.workspace, &f.device, &mut f.catalog);
    let detail = w
        .read_visible_image(d, c, &safe, &id, &image, |_, _, library| {
            let value = library.image(&image)?;
            rate(&a, &other, ContentRating::Explicit);
            Ok(value)
        })
        .unwrap();
    assert_eq!(detail.id, image);
}
