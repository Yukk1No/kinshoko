//! 永久删除（#67）：两步——预览列出受影响的参考组并给出令牌，执行时核对令牌。
//! 全部经 `Library` 的对外接口，用临时目录里的真 SQLite 与真文件；参考组用途 port 用测试假实现，
//! 另有一组测试接上生产实现 `ReferenceGroups`。

#[path = "support/eagle.rs"]
mod eagle;

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    BrowseQuery, BrowseScope, ContentRating, Error, FactSource, ImageEdit, ImportOutcome,
    ImportSource, LibraryEvent, SourceTag, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::{GroupError, GroupUsage, ReferenceGroupUsage};

fn write_png(path: &Path, seed: u8) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbaImage::from_fn(4, 4, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .save(path)
        .unwrap();
    path.to_path_buf()
}

fn import(library: &Library, dir: &Path, seeds: std::ops::Range<u8>) -> Vec<String> {
    let paths = seeds
        .map(|i| write_png(&dir.join(format!("in/{i:02}.png")), i))
        .collect();
    library
        .import(ImportSource { paths })
        .wait()
        .items
        .into_iter()
        .map(|item| match item.outcome {
            ImportOutcome::Imported { image_id } => image_id,
            other => panic!("未导入：{other:?}"),
        })
        .collect()
}

/// 新建资料库并导入 `n` 张内容不同的图，前 `trashed` 张移进回收站。
fn library_with(dir: &Path, n: u8, trashed: usize) -> (Library, Vec<String>) {
    let library = Library::create(&dir.join("lib"), "库").unwrap();
    let ids = import(&library, dir, 0..n);
    library.edit(&ids[..trashed], &[ImageEdit::Delete]).unwrap();
    (library, ids)
}

fn browse(library: &Library, scope: BrowseScope) -> Vec<String> {
    library
        .browse(&BrowseQuery {
            scope,
            conditions: Default::default(),
            cursor: None,
            limit: 1000,
            thumbnail_px: 64,
        })
        .unwrap()
        .cards
        .into_iter()
        .map(|c| c.id)
        .collect()
}

/// 假参考组：身份、名称与成员（资料库，参考图）。
type FakeGroup = (String, String, Vec<(String, String)>);

/// 参考组用途 port 的测试假实现：内存里的参考组，每组按“资料库＋参考图”列出成员。
#[derive(Default)]
struct FakeGroups {
    groups: RefCell<Vec<FakeGroup>>,
    broken: RefCell<bool>,
}

impl FakeGroups {
    fn add(&self, id: &str, name: &str, library_id: &str, image_ids: &[&String]) {
        self.groups.borrow_mut().push((
            id.into(),
            name.into(),
            image_ids
                .iter()
                .map(|i| (library_id.to_owned(), (*i).clone()))
                .collect(),
        ));
    }
}

impl ReferenceGroupUsage for FakeGroups {
    fn groups_using(
        &self,
        library_id: &str,
        image_ids: &[String],
    ) -> Result<Vec<GroupUsage>, GroupError> {
        if *self.broken.borrow() {
            return Err(GroupError::Invalid("读不懂".into()));
        }
        Ok(self
            .groups
            .borrow()
            .iter()
            .filter_map(|(id, name, members)| {
                let mut used: Vec<String> = Vec::new();
                for (lib, image) in members {
                    if lib == library_id && image_ids.contains(image) && !used.contains(image) {
                        used.push(image.clone());
                    }
                }
                (!used.is_empty()).then(|| GroupUsage {
                    group_id: id.clone(),
                    name: name.clone(),
                    image_ids: used,
                })
            })
            .collect())
    }
}

#[test]
fn preview_lists_the_reference_groups_using_the_images() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 3, 2);
    let lib = library.info().id.clone();
    let groups = FakeGroups::default();
    groups.add("g1", "脸", &lib, &[&ids[0], &ids[2]]);
    groups.add("g2", "手", "另一个库", &[&ids[1]]);

    let preview = library
        .preview_permanent_delete(&ids[..2], &groups)
        .unwrap();
    assert_eq!(preview.image_ids, ids[..2].to_vec());
    assert_eq!(
        preview.groups,
        vec![GroupUsage {
            group_id: "g1".into(),
            name: "脸".into(),
            image_ids: vec![ids[0].clone()],
        }]
    );
    assert!(!preview.token.is_empty());
}

#[test]
fn preview_without_affected_groups_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 2, 2);
    let preview = library
        .preview_permanent_delete(&ids, &FakeGroups::default())
        .unwrap();
    assert!(preview.groups.is_empty());
}

#[test]
fn only_images_in_the_trash_can_be_permanently_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 2, 1);
    let groups = FakeGroups::default();
    assert!(matches!(
        library.preview_permanent_delete(&ids, &groups),
        Err(Error::NotInTrash)
    ));
    assert!(matches!(
        library.preview_permanent_delete(&["没有这张".into()], &groups),
        Err(Error::UnknownImage)
    ));
}

/// 安全模式开启时，被封印的图在回收站里也看不见，不能经浏览视角永久删除。
#[test]
fn sealed_images_cannot_be_deleted_while_safe_mode_is_on() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 1, 1);
    library.set_safe_mode(false);
    library
        .edit(
            &ids,
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    library.set_safe_mode(true);
    let groups = FakeGroups::default();
    assert!(matches!(
        library.preview_permanent_delete(&ids, &groups),
        Err(Error::UnknownImage)
    ));
    library.set_safe_mode(false);
    let preview = library.preview_permanent_delete(&ids, &groups).unwrap();
    library.set_safe_mode(true);
    assert!(
        library
            .permanent_delete(&ids, &preview.token, &groups)
            .is_err()
    );
    library.set_safe_mode(false);
    assert_eq!(browse(&library, BrowseScope::Trash), ids);
}

/// 原文件所在位置（经对外接口取得，删除前）。
fn originals(library: &Library, ids: &[String]) -> Vec<PathBuf> {
    ids.iter()
        .map(|id| library.original_path(id).unwrap())
        .collect()
}

#[test]
fn confirming_the_preview_deletes_the_images_their_organisation_and_originals() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join("lib"), "库").unwrap();
    let ids = import(&library, dir.path(), 0..3);
    // 整理结果：文件夹、备注、标签、分级，都要随图一起删掉。
    let folder = library.create_folder("人物", None).unwrap();
    library
        .edit(
            &ids,
            &[
                ImageEdit::AddToFolder {
                    folder_id: folder.clone(),
                },
                ImageEdit::SetNote {
                    text: "备注".into(),
                },
                ImageEdit::SetRating {
                    rating: ContentRating::General,
                },
            ],
        )
        .unwrap();
    library
        .edit_tags(
            &ids,
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "短发".into(),
                    lang: "zh".into(),
                },
            }],
        )
        .unwrap();
    library
        .replace_source_tags(
            &FactSource::model("test"),
            &ids[0],
            &[SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: "blue_eyes".into(),
                },
                score: Some(0.9),
            }],
        )
        .unwrap();
    library.thumbnail(&ids[0], 128).unwrap();
    let files = originals(&library, &ids);
    library.edit(&ids[..2], &[ImageEdit::Delete]).unwrap();
    let events = library.events();

    let groups = FakeGroups::default();
    let preview = library
        .preview_permanent_delete(&ids[..2], &groups)
        .unwrap();
    library
        .permanent_delete(&ids[..2], &preview.token, &groups)
        .unwrap();

    assert!(browse(&library, BrowseScope::Trash).is_empty());
    assert_eq!(browse(&library, BrowseScope::All), vec![ids[2].clone()]);
    assert!(matches!(library.image(&ids[0]), Err(Error::UnknownImage)));
    let sidebar = library.sidebar().unwrap();
    assert_eq!((sidebar.all, sidebar.trash), (1, 0));
    assert!(!files[0].exists() && !files[1].exists());
    assert!(files[2].exists());
    // 缩略图缓存里也不再有被删的图。
    let thumbs: Vec<_> = walk(&library.info().root.join("cache"))
        .into_iter()
        .filter(|p| p.is_file())
        .collect();
    assert!(thumbs.is_empty(), "{thumbs:?}");
    // 同一张图还能重新导入。
    let again = import(&library, dir.path(), 0..1);
    assert!(library.image(&again[0]).is_ok());

    let received: Vec<LibraryEvent> = events.try_iter().collect();
    assert!(received.iter().any(|e| matches!(e,
        LibraryEvent::ImagesChanged { image_ids, .. } if image_ids == &ids[..2])));
    assert!(
        received
            .iter()
            .any(|e| matches!(e, LibraryEvent::VocabularyChanged { .. }))
    );
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        }
        out.push(path);
    }
    out
}

fn stale(library: &Library, groups: &FakeGroups, ids: &[String], token: &str) -> bool {
    matches!(
        library.permanent_delete(ids, token, groups),
        Err(Error::DeletePreviewStale)
    )
}

#[test]
fn a_change_after_the_preview_rejects_the_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 4, 3);
    let lib = library.info().id.clone();
    let groups = FakeGroups::default();

    // 回收站变化：另一张图移进回收站。
    let preview = library
        .preview_permanent_delete(&ids[..1], &groups)
        .unwrap();
    library.edit(&ids[3..], &[ImageEdit::Delete]).unwrap();
    assert!(stale(&library, &groups, &ids[..1], &preview.token));

    // 回收站变化：要删的图被恢复又删除。
    let preview = library
        .preview_permanent_delete(&ids[..1], &groups)
        .unwrap();
    library.edit(&ids[..1], &[ImageEdit::Restore]).unwrap();
    library.edit(&ids[..1], &[ImageEdit::Delete]).unwrap();
    assert!(stale(&library, &groups, &ids[..1], &preview.token));

    // 参考组变化：预览后有参考组用上了这张图。
    let preview = library
        .preview_permanent_delete(&ids[..1], &groups)
        .unwrap();
    groups.add("g", "新组", &lib, &[&ids[0]]);
    assert!(stale(&library, &groups, &ids[..1], &preview.token));

    // 安全模式切换。
    let preview = library
        .preview_permanent_delete(&ids[..1], &groups)
        .unwrap();
    library.set_safe_mode(false);
    assert!(stale(&library, &groups, &ids[..1], &preview.token));

    // 令牌只对预览时的那组图有效。
    let preview = library
        .preview_permanent_delete(&ids[..1], &groups)
        .unwrap();
    assert!(stale(&library, &groups, &ids[..2], &preview.token));

    // 被拒绝时什么都没删；重新预览后可以执行。
    assert_eq!(browse(&library, BrowseScope::Trash).len(), 4);
    let preview = library
        .preview_permanent_delete(&ids[..2], &groups)
        .unwrap();
    library
        .permanent_delete(&ids[..2], &preview.token, &groups)
        .unwrap();
    assert_eq!(browse(&library, BrowseScope::Trash).len(), 2);
    // 同一个令牌不能再用。
    assert!(
        library
            .permanent_delete(&ids[..2], &preview.token, &groups)
            .is_err()
    );
}

/// Eagle 来源的图：绑定、区域评论随图删除；删掉被取代的旧版本后新版本不再指向它，重导也不会把
/// 旧内容带回来。
#[test]
fn eagle_images_and_superseded_versions_can_be_permanently_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 4);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    let binding = |external: &str| {
        library.eagle_sources().unwrap()[0]
            .bindings
            .iter()
            .find(|b| b.external_id == external && b.state == "present")
            .map(|b| b.image_id.clone())
    };
    let old = binding("ITEM000000000").unwrap();
    let commented = binding("ITEM000000003").unwrap();
    assert!(
        library.eagle_sources().unwrap()[0]
            .bindings
            .iter()
            .any(|b| b.image_id == commented && !b.region_notes.is_empty()),
        "夹具里第 4 个条目带区域评论"
    );

    // 换掉第一个条目的原图：重导后得到新版本，旧版本被取代。
    let (width, height) = (31, 13);
    RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba([99, y as u8, x as u8, 255])
    })
    .save(fixture.original(0))
    .unwrap();
    fixture.items[0]["size"] =
        serde_json::json!(std::fs::metadata(fixture.original(0)).unwrap().len());
    fixture.items[0]["width"] = serde_json::json!(width);
    fixture.items[0]["height"] = serde_json::json!(height);
    fixture.save_item(0);
    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    let new = binding("ITEM000000000").unwrap();
    assert_ne!(new, old);

    let ids = vec![old.clone(), commented.clone()];
    library.edit(&ids, &[ImageEdit::Delete]).unwrap();
    let groups = FakeGroups::default();
    let preview = library.preview_permanent_delete(&ids, &groups).unwrap();
    library
        .permanent_delete(&ids, &preview.token, &groups)
        .unwrap();

    assert_eq!(library.image(&new).unwrap().versions.previous, None);
    let source = &library.eagle_sources().unwrap()[0];
    assert!(
        source
            .bindings
            .iter()
            .all(|b| b.image_id != old && b.image_id != commented)
    );
    assert_eq!(binding("ITEM000000003"), None);
    // 被取代的旧内容不在来源里了，重导不会带回来。
    let report = library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    assert!(
        report
            .items
            .iter()
            .all(|i| i.outcome.image_id() != Some(old.as_str())),
        "{report:?}"
    );
    assert_eq!(binding("ITEM000000000"), Some(new));
}

const CHILD: &str = "child_deletes_the_trash_until_the_fault_point";
const ROOT_ENV: &str = "KINSHOKO_TEST_LIBRARY";

/// 子进程：打开资料库，永久删除回收站里的全部图，在注入点崩溃。走到最后说明注入点没有命中。
#[test]
#[ignore = "只在故障注入子进程里运行"]
fn child_deletes_the_trash_until_the_fault_point() {
    let library = Library::open(Path::new(&std::env::var_os(ROOT_ENV).unwrap())).unwrap();
    let ids = browse(&library, BrowseScope::Trash);
    let groups = FakeGroups::default();
    let preview = library.preview_permanent_delete(&ids, &groups).unwrap();
    library
        .permanent_delete(&ids, &preview.token, &groups)
        .unwrap();
    panic!("没有在注入点崩溃");
}

/// 记录删除已提交、原文件还没清除时崩溃：重开资料库时接着清除，不留下孤立原文件。
#[test]
fn a_crash_after_commit_finishes_removing_the_originals_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 3, 2);
    library.thumbnail(&ids[0], 128).unwrap();
    let files = originals(&library, &ids);
    let root = library.info().root.clone();
    drop(library);

    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", CHILD, "--test-threads=1"])
        .env("KINSHOKO_FAULT", "permanent_delete_after_commit")
        .env(ROOT_ENV, &root)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(99), "子进程应在注入点崩溃");
    assert!(files[0].exists(), "崩溃时原文件还没清除");

    let library = Library::open(&root).unwrap();
    assert!(browse(&library, BrowseScope::Trash).is_empty());
    assert!(!files[0].exists() && !files[1].exists());
    assert!(files[2].exists());
    assert!(library.recovery().orphans.is_empty());
    let thumbs: Vec<_> = walk(&root.join("cache"))
        .into_iter()
        .filter(|p| p.is_file())
        .collect();
    assert!(thumbs.is_empty(), "{thumbs:?}");
}

#[test]
fn unreadable_reference_groups_block_preview_and_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 1, 1);
    let groups = FakeGroups::default();
    let preview = library.preview_permanent_delete(&ids, &groups).unwrap();
    *groups.broken.borrow_mut() = true;
    assert!(matches!(
        library.preview_permanent_delete(&ids, &groups),
        Err(Error::ReferenceGroups(_))
    ));
    assert!(matches!(
        library.permanent_delete(&ids, &preview.token, &groups),
        Err(Error::ReferenceGroups(_))
    ));
    assert_eq!(browse(&library, BrowseScope::Trash), ids);
}
