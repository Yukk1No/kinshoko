//! 没有变化时不重新同步（#335）：不过滤的同步之后，安全模式开着的句柄不再核对；反过来要补一次，
//! 且开着安全模式的同步不写入被藏起的标签。词表、目录或视角真的变了时照常重新同步。

use super::*;
use crate::Library;
use crate::library::{
    ContentRating, ImageEdit, ImportSource, SafeModeScope, TagEdit, TagNamespace, TagRef,
};
use image::{Rgba, RgbaImage};

fn import(library: &Library, dir: &std::path::Path, name: &str, pixel: u8) -> String {
    let path = dir.join(format!("{name}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([pixel, 2, 3, 255]))
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

/// 一张公开的图带 `public`，一张 R18 的图只带 `sealed`；句柄开着安全模式。
fn library_with_sealed_tag(dir: &std::path::Path, name: &str) -> Library {
    let library = Library::create(&dir.join(name), name).unwrap();
    let public = import(&library, dir, &format!("{name}-public"), 1);
    let adult = import(&library, dir, &format!("{name}-adult"), 2);
    tag(&library, &public, "public");
    tag(&library, &adult, "sealed");
    library
        .edit(
            &[adult],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    library.set_safe_mode(true);
    library
}

/// 图片墙那样的只读句柄：不过滤（见 `ImageGate`）。
fn unfiltered_reader(library: &Library) -> Library {
    let reader = Library::open_read_only(&library.info().root, &library.info().id).unwrap();
    reader.set_safe_mode(false);
    reader
}

fn mapped(inspection: &CatalogInspection, library: &Library) -> usize {
    inspection
        .mappings
        .iter()
        .filter(|m| m.library_id == library.info().id)
        .count()
}

#[test]
fn unfiltered_synchronization_covers_the_safe_mode_view() {
    let dir = tempfile::tempdir().unwrap();
    let writable = library_with_sealed_tag(dir.path(), "a");
    let reader = unfiltered_reader(&writable);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();

    let first = catalog.synchronize(&reader).unwrap();
    assert_eq!(mapped(&first, &writable), 2);
    for library in [&writable, &reader, &writable, &reader] {
        assert_eq!(catalog.synchronize(library).unwrap(), first);
    }
    assert_eq!(catalog.full_synchronizations, 1);
}

#[test]
fn safe_mode_synchronization_neither_covers_nor_exposes_hidden_tags() {
    let dir = tempfile::tempdir().unwrap();
    let writable = library_with_sealed_tag(dir.path(), "a");
    let reader = unfiltered_reader(&writable);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();

    let filtered = catalog.synchronize(&writable).unwrap();
    assert_eq!(mapped(&filtered, &writable), 1);
    let all = catalog.synchronize(&reader).unwrap();
    assert_eq!(mapped(&all, &writable), 2);
    // 启动时的次序：装配（开着安全模式）、图片墙快照（不过滤）、查找（开着安全模式）。
    for library in [&writable, &reader, &writable] {
        assert_eq!(catalog.synchronize(library).unwrap(), all);
    }
    assert_eq!(catalog.full_synchronizations, 2);
}

#[test]
fn a_different_safe_mode_scope_resynchronizes() {
    let dir = tempfile::tempdir().unwrap();
    let writable = library_with_sealed_tag(dir.path(), "a");
    let reader = unfiltered_reader(&writable);
    reader.set_safe_mode(true);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&reader).unwrap();
    catalog.synchronize(&writable).unwrap();
    assert_eq!(catalog.full_synchronizations, 1);

    // 只读句柄换范围不写数据库，词表修订号不动；藏起的标签可能不同，要重新核对。
    reader.set_safe_mode_scope(SafeModeScope::Explicit).unwrap();
    catalog.synchronize(&reader).unwrap();
    assert_eq!(catalog.full_synchronizations, 2);
    catalog.synchronize(&reader).unwrap();
    assert_eq!(catalog.full_synchronizations, 2);
}

#[test]
fn vocabulary_change_resynchronizes() {
    let dir = tempfile::tempdir().unwrap();
    let writable = library_with_sealed_tag(dir.path(), "a");
    let reader = unfiltered_reader(&writable);
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&reader).unwrap();

    let image = import(&writable, dir.path(), "later", 3);
    tag(&writable, &image, "later");
    // 另一个句柄读到同一个词表修订号，看到同一次变化。
    let after = catalog.synchronize(&reader).unwrap();
    assert_eq!(mapped(&after, &writable), 3);
    assert_eq!(catalog.synchronize(&writable).unwrap(), after);
    assert_eq!(catalog.full_synchronizations, 2);
}

#[test]
fn catalog_change_resynchronizes() {
    let dir = tempfile::tempdir().unwrap();
    let library = library_with_sealed_tag(dir.path(), "a");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let first = catalog.synchronize(&library).unwrap();
    let local = first.mappings[0].local_tag_id.clone();

    let corrected = catalog
        .correct(&library, &local, CatalogCorrection::Separate)
        .unwrap();
    assert!(corrected.revision > first.revision);
    assert_eq!(catalog.synchronize(&library).unwrap(), corrected);
    assert_eq!(catalog.full_synchronizations, 2);
    catalog.synchronize(&library).unwrap();
    assert_eq!(catalog.full_synchronizations, 2);
}

#[test]
fn libraries_in_turn_synchronize_once_each() {
    let dir = tempfile::tempdir().unwrap();
    let a = library_with_sealed_tag(dir.path(), "a");
    let b = library_with_sealed_tag(dir.path(), "b");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.synchronize(&a).unwrap();
    // b 的首次同步让目录修订号前进，a 的记录随之过期：再核对一次 a，之后都不变。
    catalog.synchronize(&b).unwrap();
    catalog.synchronize(&a).unwrap();
    for library in [&b, &a, &b] {
        catalog.synchronize(library).unwrap();
    }
    assert_eq!(catalog.full_synchronizations, 3);
}
