//! 永久删除 Eagle 图与旧版本、清空回收站、崩溃后收尾、参考组读不懂时（接 `permanent_delete.rs`）。

use super::*;

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

/// 清空回收站（#114）：预览列出回收站里全部可见的图与受影响的参考组，按令牌走同一永久删除。
#[test]
fn emptying_the_trash_previews_every_image_in_it_and_deletes_them_with_the_same_token() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 4, 3);
    let lib = library.info().id.clone();
    let groups = FakeGroups::default();
    groups.add("g1", "脸", &lib, &[&ids[1], &ids[3]]);

    let preview = library.preview_empty_trash(&groups).unwrap();
    let mut listed = preview.image_ids.clone();
    listed.sort();
    let mut trashed = ids[..3].to_vec();
    trashed.sort();
    assert_eq!(listed, trashed);
    assert_eq!(
        preview.groups,
        vec![GroupUsage {
            group_id: "g1".into(),
            name: "脸".into(),
            image_ids: vec![ids[1].clone()],
        }]
    );

    // 预览之后回收站变了：令牌失效，要重新预览。
    library.edit(&ids[3..4], &[ImageEdit::Delete]).unwrap();
    assert!(stale(&library, &groups, &preview.image_ids, &preview.token));
    let preview = library.preview_empty_trash(&groups).unwrap();
    assert_eq!(preview.image_ids.len(), 4);
    library
        .permanent_delete(&preview.image_ids, &preview.token, &groups)
        .unwrap();
    assert!(browse(&library, BrowseScope::Trash).is_empty());
    let sidebar = library.sidebar().unwrap();
    assert_eq!((sidebar.all, sidebar.trash), (0, 0));
    // 空回收站的预览为空。
    assert!(
        library
            .preview_empty_trash(&groups)
            .unwrap()
            .image_ids
            .is_empty()
    );
}

/// 安全模式开启时清空的只是看得见的：被封印的图留在回收站。
#[test]
fn emptying_the_trash_in_safe_mode_leaves_sealed_images() {
    let dir = tempfile::tempdir().unwrap();
    let (library, ids) = library_with(dir.path(), 2, 2);
    library.set_safe_mode(false);
    library
        .edit(
            &ids[..1],
            &[ImageEdit::SetRating {
                rating: ContentRating::Explicit,
            }],
        )
        .unwrap();
    library.set_safe_mode(true);
    let groups = FakeGroups::default();
    let preview = library.preview_empty_trash(&groups).unwrap();
    assert_eq!(preview.image_ids, [ids[1].clone()]);
    library
        .permanent_delete(&preview.image_ids, &preview.token, &groups)
        .unwrap();
    library.set_safe_mode(false);
    assert_eq!(browse(&library, BrowseScope::Trash), [ids[0].clone()]);
}

/// 清空回收站沿用永久删除的记忆：删掉的 Eagle 图重导时不再回来。
#[test]
fn emptying_the_trash_remembers_eagle_images_so_reimport_does_not_bring_them_back() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = eagle::build(&dir.path().join("主库.library"), "4.0.0", 3);
    let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
    let all = |library: &Library| browse(library, BrowseScope::All);
    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    let before = all(&library);
    library.edit(&before[..1], &[ImageEdit::Delete]).unwrap();
    let groups = FakeGroups::default();
    let preview = library.preview_empty_trash(&groups).unwrap();
    library
        .permanent_delete(&preview.image_ids, &preview.token, &groups)
        .unwrap();

    library
        .import(ImportSource {
            paths: vec![fixture.root.clone()],
        })
        .wait();
    assert_eq!(all(&library).len(), before.len() - 1);
    assert!(!all(&library).contains(&before[0]));
    assert!(browse(&library, BrowseScope::Trash).is_empty());
}

const CHILD: &str = "trash::child_deletes_the_trash_until_the_fault_point";
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
    let thumbs = cached_for(&root, &files[..2]);
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
