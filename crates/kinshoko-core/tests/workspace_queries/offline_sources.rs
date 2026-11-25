use super::*;

#[test]
fn real_multiple_directories_reuse_visible_safety_facts_and_report_action_timings() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&dir.path().join("a"), "A").unwrap();
    let b = device.create(&dir.path().join("b"), "B").unwrap();
    let paths = (0..48u8)
        .map(|red| {
            let path = dir.path().join(format!("sample-{red}.png"));
            RgbaImage::from_pixel(4, 3, Rgba([red, 34, 56, 255]))
                .save(&path)
                .unwrap();
            path
        })
        .collect::<Vec<_>>();
    let images = [&a, &b].map(|library| {
        library
            .import(ImportSource {
                paths: paths.clone(),
            })
            .wait()
            .items
            .into_iter()
            .map(|item| item.outcome.image_id().unwrap().to_owned())
            .collect::<Vec<_>>()
    });
    let folders = (0..12)
        .map(|i| {
            let folder = a.create_folder(&format!("folder {i}"), None).unwrap();
            a.edit(
                &images[0][i * 4..i * 4 + 4],
                &[ImageEdit::AddToFolder {
                    folder_id: folder.clone(),
                }],
            )
            .unwrap();
            folder
        })
        .collect::<Vec<_>>();
    b.set_safe_mode(false);
    b.edit(
        &[images[1][0].clone()],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();
    let started = std::time::Instant::now();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &WorkspaceQuery {
                limit: 100,
                ..query()
            },
            true,
        )
        .unwrap();
    let browse_ms = started.elapsed().as_millis();
    assert_eq!(page.total, 47);
    let started = std::time::Instant::now();
    let sidebar = workspace
        .sidebar(&device, &mut catalog, &a.info().id, true)
        .unwrap();
    let sidebar_ms = started.elapsed().as_millis();
    assert_eq!(sidebar.all, 47);
    assert_eq!(sidebar.folders.len(), 12);
    assert_eq!(
        sidebar
            .folders
            .iter()
            .find(|f| f.id == folders[0])
            .unwrap()
            .count,
        3
    );
    assert_eq!(sidebar.folders.iter().filter(|f| f.count == 4).count(), 11);
    let started = std::time::Instant::now();
    for (i, image) in images[0].iter().enumerate() {
        assert_eq!(
            workspace
                .contains(&device, &mut catalog, &a.info().id, image, true)
                .unwrap(),
            i != 0
        );
    }
    println!(
        "T07 real 2-provider/96-source/48-byte-identities/12-folder actions: browse={browse_ms}ms sidebar={sidebar_ms}ms 48 authorizations={}ms",
        started.elapsed().as_millis()
    );
}

#[test]
fn narrow_browse_and_single_card_keep_offline_adult_veto_and_all_sources_via_sha256_index() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let a_dir = dir.path().join("a");
    let b_dir = dir.path().join("b");
    let b_moved = dir.path().join("b-offline");
    let mut device = DeviceLibraries::open(&app).unwrap();
    let a = device.create(&a_dir, "A").unwrap();
    let b = device.create(&b_dir, "B").unwrap();

    // 导入多张无关参考图，确保窄查询不会退化或漏算。
    for seed in 0..20u8 {
        let p = dir.path().join(format!("noise-{seed}.png"));
        RgbaImage::from_pixel(2, 2, Rgba([seed, 10, 20, 255]))
            .save(&p)
            .unwrap();
        let target = if seed % 2 == 0 { &a } else { &b };
        target.import(ImportSource { paths: vec![p] }).wait();
    }

    let shared_file = dir.path().join("shared.png");
    RgbaImage::from_pixel(3, 3, Rgba([200, 100, 50, 255]))
        .save(&shared_file)
        .unwrap();
    let a_shared = a
        .import(ImportSource {
            paths: vec![shared_file.clone()],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    let b_shared = b
        .import(ImportSource {
            paths: vec![shared_file],
        })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();

    let focus = a.create_folder("focus", None).unwrap();
    a.edit(
        std::slice::from_ref(&a_shared),
        &[ImageEdit::AddToFolder {
            folder_id: focus.clone(),
        }],
    )
    .unwrap();
    b.set_safe_mode(false);
    b.edit(
        &[b_shared],
        &[ImageEdit::SetRating {
            rating: ContentRating::Explicit,
        }],
    )
    .unwrap();

    let a_id = a.info().id.clone();
    let b_id = b.info().id.clone();
    let mut catalog = TagCatalog::open(&app).unwrap();
    let mut workspace = Workspace::open(&app).unwrap();

    // 先刷新一次记录跨库事实，再释放所有只读/可写句柄并使 B 下线。
    let initial = workspace
        .browse(&device, &mut catalog, &query(), false)
        .unwrap();
    assert_eq!(initial.total, 21);

    drop(a);
    drop(b);
    drop(device);
    workspace.release_readers();
    std::fs::rename(&b_dir, &b_moved).unwrap();

    let device = DeviceLibraries::open(&app).unwrap();
    let folder_query = WorkspaceQuery {
        scope: WorkspaceScope::Library {
            library_id: a_id.clone(),
            scope: kinshoko_core::library::BrowseScope::Folder { id: focus },
        },
        ..query()
    };

    // 安全模式开启：即使只查 A 的单文件夹或单卡，仍因离线库 B 的成人标记被否决隐藏。
    let safe_page = workspace
        .browse(&device, &mut catalog, &folder_query, true)
        .unwrap();
    assert_eq!(safe_page.total, 0);
    assert!(matches!(
        workspace.card(&device, &mut catalog, &a_id, &a_shared, true),
        Err(kinshoko_core::tag_catalog::CatalogError::Library(
            kinshoko_core::library::Error::UnknownImage
        ))
    ));

    // 安全模式关闭：窄查询与单卡均返回 A 与离线库 B 的完整来源列表。
    let unsafe_page = workspace
        .browse(&device, &mut catalog, &folder_query, false)
        .unwrap();
    assert_eq!(unsafe_page.total, 1);
    let page_card = &unsafe_page.cards[0];
    assert_eq!(page_card.sources.len(), 2);
    assert!(
        page_card
            .sources
            .iter()
            .any(|s| s.library_id == a_id && s.matches && s.unavailable.is_none())
    );
    assert!(
        page_card
            .sources
            .iter()
            .any(|s| s.library_id == b_id && !s.matches && s.unavailable.is_some())
    );

    let single = workspace
        .card(&device, &mut catalog, &a_id, &a_shared, false)
        .unwrap();
    assert_eq!(single.sources.len(), 2);
    assert!(
        single
            .sources
            .iter()
            .any(|s| s.library_id == a_id && s.matches && s.unavailable.is_none())
    );
    assert!(
        single
            .sources
            .iter()
            .any(|s| s.library_id == b_id && !s.matches && s.unavailable.is_some())
    );
}
