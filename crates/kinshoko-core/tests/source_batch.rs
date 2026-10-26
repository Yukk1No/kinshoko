//! 同一资料库的多份来源一次整理（#290）。
use super::source_actions::{same_image_in_two_libraries, source_in};
use kinshoko_core::library::{ImageEdit, ImportSource};

/// 同一图库的多份来源一次整理（#290）：只核对一次、只调一次整理，拿到全部图片 id；
/// 有一份来源不再是所选的那份，或不属于这个可写句柄的图库时，整批都不做。
#[test]
fn several_sources_of_one_library_are_edited_in_one_action() {
    use kinshoko_core::workspace::WorkspaceSourceTarget;
    let temp = tempfile::tempdir().unwrap();
    let (mut device, a, b, mut catalog, mut workspace) = same_image_in_two_libraries(temp.path());
    let other = temp.path().join("other.png");
    image::RgbImage::from_pixel(9, 9, image::Rgb([200, 10, 10]))
        .save(&other)
        .unwrap();
    b.import(ImportSource { paths: vec![other] }).wait();
    let page = workspace
        .browse(
            &device,
            &mut catalog,
            &kinshoko_core::workspace::WorkspaceQuery {
                scope: Default::default(),
                conditions: Default::default(),
                cursor: None,
                limit: 10,
                thumbnail_px: 256,
            },
            true,
        )
        .unwrap();
    let targets: Vec<WorkspaceSourceTarget> = page
        .cards
        .iter()
        .map(|card| WorkspaceSourceTarget {
            library_id: b.info().id.clone(),
            image_id: source_in(card, &b),
            content_id: card.id.clone(),
        })
        .collect();
    assert_eq!(targets.len(), 2);
    let writer = match device.organize(&b.info().id).unwrap() {
        kinshoko_core::WriterAccess::Ready { library, .. } => library,
        kinshoko_core::WriterAccess::Waiting(_) => panic!("不应等待"),
    };

    let mut changed = targets.clone();
    changed[1].content_id = "别的字节".into();
    let error = workspace
        .write_sources_with(
            &device,
            &mut catalog,
            &changed,
            true,
            &writer,
            |library, ids| library.edit(ids, &[ImageEdit::Delete]),
        )
        .unwrap_err();
    assert!(error.to_string().contains("来源"), "{error}");
    let mut mixed = targets.clone();
    mixed[0].library_id = a.info().id.clone();
    assert!(
        workspace
            .write_sources_with(
                &device,
                &mut catalog,
                &mixed,
                true,
                &writer,
                |library, ids| { library.edit(ids, &[ImageEdit::Delete]) }
            )
            .is_err()
    );
    for target in &targets {
        assert_eq!(
            b.image(&target.image_id).unwrap().deleted_at,
            None,
            "整批都不做"
        );
    }

    let mut calls = Vec::new();
    workspace
        .write_sources_with(
            &device,
            &mut catalog,
            &targets,
            true,
            &writer,
            |library, ids| {
                calls.push(ids.to_vec());
                library.edit(ids, &[ImageEdit::Delete])
            },
        )
        .unwrap();
    assert_eq!(
        calls,
        vec![
            targets
                .iter()
                .map(|t| t.image_id.clone())
                .collect::<Vec<_>>()
        ]
    );
    for target in &targets {
        assert!(b.image(&target.image_id).unwrap().deleted_at.is_some());
    }
    let shared = page
        .cards
        .iter()
        .find(|card| card.sources.len() == 2)
        .unwrap();
    assert_eq!(a.image(&source_in(shared, &a)).unwrap().deleted_at, None);
}

/// 按图库分组：图库按第一次出现的先后，组内去重（#290）。
#[test]
fn sources_are_grouped_by_library_in_first_seen_order() {
    use kinshoko_core::workspace::{WorkspaceSourceTarget, group_sources};
    let t = |library: &str, image: &str| WorkspaceSourceTarget {
        library_id: library.into(),
        image_id: image.into(),
        content_id: format!("c{image}"),
    };
    let batches = group_sources(&[t("L2", "1"), t("L1", "2"), t("L2", "3"), t("L2", "1")]);
    assert_eq!(
        batches
            .iter()
            .map(|b| (
                b.library_id.as_str(),
                b.targets
                    .iter()
                    .map(|t| t.image_id.as_str())
                    .collect::<Vec<_>>()
            ))
            .collect::<Vec<_>>(),
        vec![("L2", vec!["1", "3"]), ("L1", vec!["2"])]
    );
}
