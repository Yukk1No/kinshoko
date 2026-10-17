//! 跨图库的批量整理（ADR-0008，#112）：所选的图按图库分组，逐组把可写句柄切过去执行；
//! 某个图库不可用时其他图库照常完成，并按图库报告没完成的原因。
//! 只经对外接口，用临时目录里的真 SQLite 与真文件；参考组用途 port 用测试假实现。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::RgbaImage;
use kinshoko_core::library::{BrowseQuery, BrowseScope, ImageEdit, ImportOutcome, ImportSource};
use kinshoko_core::library_batch::{LibraryBatch, LibraryTarget, each_library, group_by_library};
use kinshoko_core::reference_groups::{GroupError, GroupUsage, ReferenceGroupUsage};
use kinshoko_core::{DeviceLibraries, Library, WriterAccess};

struct NoGroups;
impl ReferenceGroupUsage for NoGroups {
    fn groups_using(&self, _: &str, _: &[String]) -> Result<Vec<GroupUsage>, GroupError> {
        Ok(Vec::new())
    }
}

fn target(library_id: &str, image_id: &str) -> LibraryTarget {
    LibraryTarget {
        library_id: library_id.into(),
        image_id: image_id.into(),
    }
}

fn write_png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(4, 4, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

/// 建库，导入 `seeds` 对应的图并全部移进回收站，返回（根目录，id，图 id）。
fn trashed_library(
    dir: &Path,
    name: &str,
    seeds: std::ops::Range<u8>,
) -> (PathBuf, String, Vec<String>) {
    let root = dir.join(name);
    let library = Library::create(&root, name).unwrap();
    let paths = seeds
        .map(|i| write_png(&dir.join(format!("in-{name}/{i:02}.png")), i))
        .collect();
    let ids: Vec<String> = library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect();
    library.edit(&ids, &[ImageEdit::Delete]).unwrap();
    (root, library.info().id.clone(), ids)
}

fn trash(library: &Library) -> usize {
    library
        .browse(&BrowseQuery {
            scope: BrowseScope::Trash,
            conditions: Default::default(),
            cursor: None,
            limit: 100,
            thumbnail_px: 64,
        })
        .unwrap()
        .total as usize
}

fn writer(device: &mut DeviceLibraries, library_id: &str) -> Result<Arc<Library>, String> {
    match device.organize(library_id).map_err(|e| e.to_string())? {
        WriterAccess::Ready { library, .. } => Ok(library),
        WriterAccess::Waiting(wait) => Err(format!("等待：{:?}", wait.notice)),
    }
}

#[test]
fn targets_are_grouped_by_library_in_first_seen_order_without_duplicates() {
    let groups = group_by_library(&[
        target("B", "b1"),
        target("A", "a1"),
        target("B", "b2"),
        target("B", "b1"),
        target("A", "a2"),
    ]);
    assert_eq!(
        groups,
        [
            LibraryBatch {
                library_id: "B".into(),
                image_ids: vec!["b1".into(), "b2".into()],
            },
            LibraryBatch {
                library_id: "A".into(),
                image_ids: vec!["a1".into(), "a2".into()],
            },
        ]
    );
}

/// “全部图片”里跨三个图库彻底删除：逐组切换可写句柄执行；B 断连时 A、C 照常删除，只报告 B。
#[test]
fn a_cross_library_permanent_delete_switches_per_library_and_continues_past_an_unavailable_one() {
    let dir = tempfile::tempdir().unwrap();
    let (a_root, a, a_ids) = trashed_library(dir.path(), "工作参考", 0..2);
    let (b_root, b, b_ids) = trashed_library(dir.path(), "移动盘参考", 10..12);
    let (c_root, c, c_ids) = trashed_library(dir.path(), "私人收藏", 20..21);
    let mut device = DeviceLibraries::open(&dir.path().join("app")).unwrap();
    for root in [&b_root, &c_root, &a_root] {
        device.register(root).unwrap();
    }
    let targets: Vec<LibraryTarget> = [
        target(&c, &c_ids[0]),
        target(&a, &a_ids[0]),
        target(&b, &b_ids[0]),
        target(&a, &a_ids[1]),
        target(&b, &b_ids[1]),
    ]
    .into();

    // 预览：每组在它自己的图库上核对并取令牌。
    let previews = each_library(group_by_library(&targets), |batch| {
        writer(&mut device, &batch.library_id)?
            .preview_permanent_delete(&batch.image_ids, &NoGroups)
            .map_err(|e| e.to_string())
    });
    assert_eq!(previews.len(), 3);
    assert!(previews.iter().all(|(_, preview)| preview.is_ok()));

    // 确认前 B 的移动盘被拔掉。预览最后一组是 B，可写句柄还开着它的数据库，
    // Windows 不允许改名有打开句柄的目录，测试里先把句柄切回 A 再模拟拔盘。
    writer(&mut device, &a).unwrap();
    std::fs::rename(&b_root, dir.path().join("盘已拔出")).unwrap();
    let results = each_library(
        previews
            .into_iter()
            .map(|(batch, preview)| (batch, preview.unwrap())),
        |(batch, preview)| {
            writer(&mut device, &batch.library_id)?
                .permanent_delete(&preview.image_ids, &preview.token, &NoGroups)
                .map_err(|e| e.to_string())
        },
    );

    let failed: Vec<&str> = results
        .iter()
        .filter(|(_, result)| result.is_err())
        .map(|((batch, _), _)| batch.library_id.as_str())
        .collect();
    assert_eq!(failed, [b.as_str()], "只报告不可用的那个图库");
    let reason = results
        .iter()
        .find_map(|(_, result)| result.as_ref().err())
        .unwrap();
    assert!(reason.contains("资料库暂时不可用"), "{reason}");
    assert_eq!(trash(&device.read(&a).unwrap()), 0, "A 照常删除");
    assert_eq!(trash(&device.read(&c).unwrap()), 0, "B 之后的 C 也照常删除");
    std::fs::rename(dir.path().join("盘已拔出"), &b_root).unwrap();
    assert_eq!(trash(&device.read(&b).unwrap()), 2, "B 的图都还在回收站");
}
