use image::{Rgba, RgbaImage};
use kinshoko_core::library::{BrowseScope, ImageEdit, ImportSource};
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::workspace::{Workspace, WorkspaceQuery, WorkspaceScope};
use kinshoko_core::{DeviceLibraries, Library};

fn import(library: &Library, dir: &std::path::Path, seed: u8) -> String {
    let path = dir.join(format!("{seed}.png"));
    RgbaImage::from_pixel(4, 3, Rgba([seed, 34, 56, 255]))
        .save(&path)
        .unwrap();
    library
        .import(ImportSource { paths: vec![path] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .into()
}
fn query(library: &Library, scope: BrowseScope) -> WorkspaceQuery {
    WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: library.info().id.clone(),
            scope,
        },
        conditions: Default::default(),
        cursor: None,
        limit: 100,
        thumbnail_px: 240,
    }
}
#[test]
fn folder_structure_changes_invalidate_workspace_directory_and_pagination_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device
        .create(&dir.path().join("library"), "资料库")
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let before = workspace.status(&device, &mut catalog, true).unwrap();
    let folder = library.create_folder("画法", None).unwrap();
    let created = workspace.status(&device, &mut catalog, true).unwrap();
    assert_ne!(
        before.revision, created.revision,
        "new folders must refresh the visible forest"
    );
    library.rename_folder(&folder, "厚涂").unwrap();
    let renamed = workspace.status(&device, &mut catalog, true).unwrap();
    assert_ne!(
        created.revision, renamed.revision,
        "renames must replace old folder labels"
    );
    let parent = library.create_folder("人物", None).unwrap();
    let before_move = workspace.status(&device, &mut catalog, true).unwrap();
    library.move_folder(&folder, Some(&parent), 0).unwrap();
    let moved = workspace.status(&device, &mut catalog, true).unwrap();
    assert_ne!(
        before_move.revision, moved.revision,
        "reparenting changes descendant membership"
    );
}

#[test]
fn exact_and_descendant_scopes_preserve_each_source_folder_memberships_and_file_paths() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "同名资料库").unwrap();
    let b = device.create(&dir.path().join("b"), "同名资料库").unwrap();
    let root = a.create_folder("画法", None).unwrap();
    let child = a.create_folder("厚涂", Some(&root)).unwrap();
    let other = a.create_folder("精选", None).unwrap();
    let b_root = b.create_folder("画法", None).unwrap();
    let direct = import(&a, dir.path(), 11);
    let nested = import(&a, dir.path(), 22);
    let _unassigned = import(&a, dir.path(), 33);
    let b_copy = import(&b, dir.path(), 22);
    a.edit(
        &[direct],
        &[ImageEdit::AddToFolder {
            folder_id: root.clone(),
        }],
    )
    .unwrap();
    a.edit(
        std::slice::from_ref(&nested),
        &[
            ImageEdit::AddToFolder {
                folder_id: child.clone(),
            },
            ImageEdit::AddToFolder {
                folder_id: other.clone(),
            },
        ],
    )
    .unwrap();
    b.edit(&[b_copy], &[ImageEdit::AddToFolder { folder_id: b_root }])
        .unwrap();
    let original = a.original_path(&nested).unwrap();
    let original_bytes = std::fs::read(&original).unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &query(&a, BrowseScope::Folder { id: root.clone() }),
                true
            )
            .unwrap()
            .total,
        1
    );
    let descendants: BrowseScope =
        serde_json::from_value(serde_json::json!({"kind":"folderTree", "id":root}))
            .expect("descendant scope must be available through the public query");
    let page = workspace
        .browse(&device, &mut catalog, &query(&a, descendants), true)
        .unwrap();
    assert_eq!(
        page.total, 2,
        "parent scope includes a descendant once, despite its additional membership"
    );
    let nested_card = page.cards.iter().find(|c| c.image_id == nested).unwrap();
    assert_eq!(nested_card.sources.len(), 2);
    assert_eq!(
        nested_card.sources.iter().filter(|s| s.matches).count(),
        1,
        "other provider's same-named folder does not join this scope"
    );
    let detail = a.image(&nested).unwrap();
    assert_eq!(detail.folders.len(), 2);
    assert!(detail.folders.iter().any(|f| f.id == child));
    assert!(detail.folders.iter().any(|f| f.id == other));
    assert_eq!(a.original_path(&nested).unwrap(), original);
    assert_eq!(std::fs::read(original).unwrap(), original_bytes);
    assert_eq!(
        device.current().unwrap().info().id,
        b.info().id,
        "browsing another provider never activates it"
    );
}
#[test]
fn a_directory_forest_keeps_same_named_libraries_and_folders_independent() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "参考").unwrap();
    let b = device.create(&dir.path().join("b"), "参考").unwrap();
    let a_root = a.create_folder("人物", None).unwrap();
    let a_child = a.create_folder("动作", Some(&a_root)).unwrap();
    let b_root = b.create_folder("人物", None).unwrap();
    let b_child = b.create_folder("动作", Some(&b_root)).unwrap();
    let image = import(&a, dir.path(), 44);
    a.edit(
        &[image],
        &[ImageEdit::AddToFolder {
            folder_id: a_child.clone(),
        }],
    )
    .unwrap();
    import(&b, dir.path(), 55);
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let forest = workspace.directories(&device, &mut catalog, true).unwrap();
    assert_eq!(forest.providers.len(), 2);
    let left = forest
        .providers
        .iter()
        .find(|p| p.registration.library.id == a.info().id)
        .unwrap();
    let right = forest
        .providers
        .iter()
        .find(|p| p.registration.library.id == b.info().id)
        .unwrap();
    let left_tree = &left.sidebar.as_ref().unwrap().folders;
    let right_tree = &right.sidebar.as_ref().unwrap().folders;
    assert_eq!(left_tree[0].id, a_root);
    assert_eq!(left_tree[0].children[0].id, a_child);
    assert_eq!(left_tree[0].children[0].count, 1);
    assert_eq!(right_tree[0].id, b_root);
    assert_eq!(right_tree[0].children[0].id, b_child);
    assert_eq!(right_tree[0].children[0].count, 0);
    assert_eq!(left.unassigned, 0);
    assert_eq!(right.unassigned, 1);
    assert_eq!(device.current().unwrap().info().id, b.info().id);
}
#[test]
fn invalid_or_unavailable_scopes_are_explicit_and_never_expand_to_another_provider() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "甲").unwrap();
    let b = device.create(&dir.path().join("b"), "乙").unwrap();
    let folder = a.create_folder("人物", None).unwrap();
    import(&a, dir.path(), 66);
    import(&b, dir.path(), 77);
    let scope = query(&a, BrowseScope::FolderTree { id: folder.clone() });
    let unknown_folder = query(&b, BrowseScope::FolderTree { id: folder });
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    assert!(
        workspace
            .browse(&device, &mut catalog, &unknown_folder, true)
            .unwrap_err()
            .to_string()
            .contains("没有这个文件夹")
    );
    let a_id = a.info().id.clone();
    drop(a);
    std::fs::rename(dir.path().join("a"), dir.path().join("disconnected-a")).unwrap();
    let forest = workspace.directories(&device, &mut catalog, true).unwrap();
    let missing = forest
        .providers
        .iter()
        .find(|p| p.registration.library.id == a_id)
        .unwrap();
    assert!(missing.registration.unavailable.is_some());
    assert!(
        missing.sidebar.is_none(),
        "an unavailable provider cannot expose a cached valid directory tree"
    );
    assert!(
        workspace
            .browse(&device, &mut catalog, &scope, true)
            .is_err(),
        "a selected missing provider is an explicit unavailable scope, not an empty successful query"
    );
    device.unregister(&a_id).unwrap();
    assert!(
        workspace
            .browse(&device, &mut catalog, &scope, true)
            .is_err(),
        "a removed provider does not silently turn into all providers"
    );
}
#[test]
fn moving_a_subtree_changes_descendant_results_and_rejects_old_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let library = device.create(&dir.path().join("a"), "A").unwrap();
    let root = library.create_folder("父", None).unwrap();
    let child = library.create_folder("子", Some(&root)).unwrap();
    let sibling = library.create_folder("其他", None).unwrap();
    let direct = import(&library, dir.path(), 88);
    let nested = import(&library, dir.path(), 99);
    library
        .edit(
            &[direct],
            &[ImageEdit::AddToFolder {
                folder_id: root.clone(),
            }],
        )
        .unwrap();
    library
        .edit(
            &[nested],
            &[ImageEdit::AddToFolder {
                folder_id: child.clone(),
            }],
        )
        .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let mut request = query(&library, BrowseScope::FolderTree { id: root });
    request.limit = 1;
    let page = workspace
        .browse(&device, &mut catalog, &request, true)
        .unwrap();
    assert_eq!(page.total, 2);
    request.cursor = page.next_cursor;
    library.move_folder(&child, Some(&sibling), 0).unwrap();
    assert!(
        workspace
            .browse(&device, &mut catalog, &request, true)
            .is_err()
    );
    request.cursor = None;
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &request, true)
            .unwrap()
            .total,
        1
    );
    request.scope = WorkspaceScope::Library {
        library_id: library.info().id.clone(),
        scope: BrowseScope::FolderTree { id: sibling },
    };
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &request, true)
            .unwrap()
            .total,
        1
    );
}
#[test]
fn folder_and_unassigned_counts_keep_the_all_source_adult_veto() {
    use kinshoko_core::library::ContentRating;
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let folder = a.create_folder("人物", None).unwrap();
    let ai = import(&a, dir.path(), 111);
    let bi = import(&b, dir.path(), 111);
    a.edit(
        &[ai],
        &[ImageEdit::AddToFolder {
            folder_id: folder.clone(),
        }],
    )
    .unwrap();
    b.edit(
        &[bi],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let request = query(&a, BrowseScope::FolderTree { id: folder });
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &request, true)
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &request, false)
            .unwrap()
            .total,
        1
    );
    let safe = workspace.directories(&device, &mut catalog, true).unwrap();
    assert!(
        safe.providers
            .iter()
            .all(|p| p.sidebar.as_ref().unwrap().all == 0 && p.unassigned == 0)
    );
    assert_eq!(
        safe.providers
            .iter()
            .find(|p| p.registration.library.id == a.info().id)
            .unwrap()
            .sidebar
            .as_ref()
            .unwrap()
            .folders[0]
            .count,
        0
    );
    assert_eq!(
        workspace
            .browse(
                &device,
                &mut catalog,
                &query(&b, BrowseScope::Unassigned),
                true
            )
            .unwrap()
            .total,
        0
    );
    assert!(
        a.safe_mode() && b.safe_mode(),
        "directory readers cannot weaken either active library lens"
    );
    drop(workspace);
    drop(b);
    drop(device);
    std::fs::rename(dir.path().join("b"), dir.path().join("disconnected-b")).unwrap();
    let device = DeviceLibraries::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    assert_eq!(
        workspace
            .browse(&device, &mut catalog, &request, true)
            .unwrap()
            .total,
        0,
        "the cached Adult source veto survives disconnect and process restart"
    );
}

#[test]
fn directory_descendant_counts_deduplicate_memberships_and_apply_global_safety() {
    use kinshoko_core::library::ContentRating;
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "参考").unwrap();
    let b = device.create(&dir.path().join("b"), "参考").unwrap();
    let root = a.create_folder("人物", None).unwrap();
    let first = a.create_folder("动作", Some(&root)).unwrap();
    let second = a.create_folder("表情", Some(&root)).unwrap();
    let direct = import(&a, dir.path(), 121);
    let nested = import(&a, dir.path(), 122);
    let shared = import(&a, dir.path(), 123);
    let adult_source = import(&b, dir.path(), 123);
    a.edit(
        &[direct],
        &[ImageEdit::AddToFolder {
            folder_id: root.clone(),
        }],
    )
    .unwrap();
    a.edit(
        &[nested],
        &[
            ImageEdit::AddToFolder {
                folder_id: first.clone(),
            },
            ImageEdit::AddToFolder {
                folder_id: second.clone(),
            },
        ],
    )
    .unwrap();
    a.edit(
        &[shared],
        &[
            ImageEdit::AddToFolder {
                folder_id: root.clone(),
            },
            ImageEdit::AddToFolder {
                folder_id: first.clone(),
            },
            ImageEdit::AddToFolder {
                folder_id: second.clone(),
            },
        ],
    )
    .unwrap();
    b.edit(
        &[adult_source],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    for (safe, direct_count, descendant_count) in [(true, 1, 2), (false, 2, 3)] {
        let forest = workspace.directories(&device, &mut catalog, safe).unwrap();
        let provider = forest
            .providers
            .iter()
            .find(|p| p.registration.library.id == a.info().id)
            .unwrap();
        assert_eq!(
            provider.sidebar.as_ref().unwrap().folders[0].count,
            direct_count
        );
        let serialized = serde_json::to_value(provider).unwrap();
        assert_eq!(
            serialized["descendants"][&root], descendant_count,
            "each visible image is counted once across parent and multiple child memberships"
        );
        assert_eq!(serialized["descendants"][&first], direct_count);
        assert_eq!(serialized["descendants"][&second], direct_count);
        assert_eq!(
            workspace
                .sidebar(&device, &mut catalog, &a.info().id, safe)
                .unwrap()
                .folders[0]
                .count,
            direct_count,
            "the legacy sidebar keeps direct-level count semantics"
        );
    }
}
