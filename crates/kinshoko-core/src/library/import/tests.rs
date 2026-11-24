use super::*;

struct NoGroups;
impl crate::reference_groups::ReferenceGroupUsage for NoGroups {
    fn groups_using(
        &self,
        _: &str,
        _: &[String],
    ) -> Result<Vec<crate::reference_groups::GroupUsage>, crate::reference_groups::GroupError> {
        Ok(Vec::new())
    }
}

#[test]
fn a_merge_whose_original_is_deleted_before_its_turn_is_staged_again() {
    use super::super::{ImageEdit, Library};
    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("a.png");
    image::RgbaImage::from_fn(16, 12, |x, y| image::Rgba([x as u8, y as u8, 90, 255]))
        .save(&png)
        .unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let first = library
        .import(ImportSource {
            paths: vec![png.clone()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let inner = &library.inner;
    let context = ImportContext {
        destination: SaveDestination {
            library_id: inner.info.id.clone(),
            folder_id: None,
        },
        task_created_images: Arc::default(),
        cancel: None,
    };
    // 准备时同库已有这份内容：判定为合并，不暂存。
    let prepared = prepare_file(inner, &png, ImportOptions::default(), &context);
    assert!(matches!(prepared, Prepared::Merge { .. }));

    // 轮到提交之前，那份原图被移进回收站并永久删除。
    library
        .edit(std::slice::from_ref(&first), &[ImageEdit::Delete])
        .unwrap();
    let preview = library
        .preview_permanent_delete(std::slice::from_ref(&first), &NoGroups)
        .unwrap();
    library
        .permanent_delete(&[first], &preview.token, &NoGroups)
        .unwrap();

    // 提交时重新暂存并发布：作为新图进库，记录指向的原文件确实存在。
    let (outcome, _) = complete(inner, prepared);
    let ImportOutcome::Imported { image_id } = outcome else {
        panic!("应作为新图重新进库：{outcome:?}");
    };
    assert!(library.original_path(&image_id).unwrap().is_file());
}
