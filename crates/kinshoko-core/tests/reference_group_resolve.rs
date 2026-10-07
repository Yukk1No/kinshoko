//! 参考组的跨库核对（#66）：成员可引用当前未激活的资料库；资料库不可用、图已删除时标出原因；
//! 安全模式下被封印的成员标记需要遮蔽。用临时目录里的真资料库，经 `kinshoko_core` 的对外接口。

use std::path::Path;

use image::RgbaImage;
use kinshoko_core::desktop::{Placement, SavedPin};
use kinshoko_core::library::{
    ContentRating, FactSource, ImageEdit, ImportOutcome, ImportSource, RatingFact, ReferenceLens,
};
use kinshoko_core::reference_groups::{
    DetachedLenses, GroupUsage, MemberState, ReferenceGroupUsage, ReferenceGroups, ReferenceSource,
    References, UnavailableReason, resolve,
};
use kinshoko_core::{Library, RegisteredLibrary};

fn import(library: &Library, dir: &Path, n: u8) -> Vec<String> {
    let paths: Vec<_> = (0..n)
        .map(|i| {
            let path = dir.join(format!("{i}.png"));
            std::fs::create_dir_all(dir).unwrap();
            RgbaImage::from_fn(6, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                .save(&path)
                .unwrap();
            path
        })
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

fn rate_explicit(library: &Library, id: &str) {
    library
        .replace_source_rating(
            &FactSource::model("test"),
            id,
            Some(RatingFact {
                rating: ContentRating::Explicit,
                score: Some(0.9),
            }),
        )
        .unwrap();
}

fn registered(library: &Library) -> RegisteredLibrary {
    RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }
}

fn pin(lens: &ReferenceLens, image_id: &str, x: i32) -> SavedPin {
    let image = lens.image(image_id).unwrap();
    SavedPin::reference(
        &format!("pin-{x}"),
        lens.library_id(),
        &image,
        None,
        Placement {
            x,
            ..Placement::default()
        },
    )
    .unwrap()
}

/// 两个资料库：A 是活动库，B 已关闭（未激活）。B 里第二张图被封印（露骨）。
struct Fixture {
    dir: tempfile::TempDir,
    a: Library,
    a_lens: ReferenceLens,
    a_images: Vec<String>,
    b: RegisteredLibrary,
    b_images: Vec<String>,
    registry: Vec<RegisteredLibrary>,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let (b, b_images) = {
            let b = Library::create(&dir.path().join("lib-b"), "B").unwrap();
            b.set_safe_mode(false);
            let ids = import(&b, &dir.path().join("in-b"), 3);
            rate_explicit(&b, &ids[1]);
            (registered(&b), ids)
        };
        let a = Library::create(&dir.path().join("lib-a"), "A").unwrap();
        let a_images = import(&a, &dir.path().join("in-a"), 2);
        let a_lens = a.take_reference_lens().unwrap();
        let registry = vec![registered(&a), b.clone()];
        Fixture {
            dir,
            a,
            a_lens,
            a_images,
            b,
            b_images,
            registry,
        }
    }

    fn references<'a>(&'a self, detached: &'a DetachedLenses, safe_mode: bool) -> References<'a> {
        References {
            current: Some(self.a_lens.clone()),
            registry: &self.registry,
            detached,
            safe_mode,
        }
    }

    /// B 的一张图做成的钉图（经只读视角取尺寸）。
    fn b_pin(&self, detached: &DetachedLenses, index: usize, x: i32) -> SavedPin {
        let lens = self.references(detached, false).lens(&self.b.id).unwrap();
        pin(&lens, &self.b_images[index], x)
    }
}

#[test]
fn a_group_resolves_members_from_the_active_and_an_inactive_library() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let groups = ReferenceGroups::open(&f.dir.path().join("groups")).unwrap();
    let group = groups
        .create(
            "跨库",
            &mut [
                pin(&f.a_lens, &f.a_images[0], 0),
                f.b_pin(&detached, 0, 100),
            ],
        )
        .unwrap();
    assert_eq!(
        group.library_ids(),
        vec![f.a.info().id.clone(), f.b.id.clone()]
    );

    let refs = f.references(&detached, true);
    let status = resolve(&group, &refs);
    assert_eq!(status.len(), 2);
    for s in &status {
        assert_eq!(s.state, MemberState::Available { sealed: false }, "{s:?}");
    }
    // 未激活的库也能取到显示用的文件。
    let b_lens = refs.lens(&f.b.id).unwrap();
    let file = b_lens.display(&f.b_images[0]).unwrap();
    assert!(file.path.is_file());
    let scaled = b_lens.display_scaled(&f.b_images[0], 3).unwrap();
    assert!(scaled.path.is_file());
}

#[test]
fn an_inactive_library_can_still_be_opened_as_the_active_one() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let refs = f.references(&detached, true);
    refs.lens(&f.b.id).unwrap().image(&f.b_images[0]).unwrap();
    let b = Library::open(&f.b.root).expect("只读视角不妨碍正常打开");
    b.set_safe_mode(false);
    b.edit(
        &[f.b_images[0].clone()],
        &[ImageEdit::SetNote {
            text: "改过".into(),
        }],
    )
    .unwrap();
    // 只读视角照常读到。
    assert!(refs.lens(&f.b.id).unwrap().image(&f.b_images[0]).is_ok());
}

#[test]
fn sealed_members_in_an_inactive_library_follow_the_safe_mode_setting() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let groups = ReferenceGroups::open(&f.dir.path().join("groups")).unwrap();
    let group = groups
        .create(
            "组",
            &mut [f.b_pin(&detached, 1, 0), f.b_pin(&detached, 0, 50)],
        )
        .unwrap();

    let on = resolve(&group, &f.references(&detached, true));
    assert_eq!(on[0].state, MemberState::Available { sealed: true });
    assert_eq!(on[1].state, MemberState::Available { sealed: false });

    let off = resolve(&group, &f.references(&detached, false));
    assert_eq!(off[0].state, MemberState::Available { sealed: false });
}

#[test]
fn sealed_members_in_the_active_library_are_marked_through_its_reference_lens() {
    let f = Fixture::new();
    f.a.set_safe_mode(false);
    rate_explicit(&f.a, &f.a_images[1]);
    let detached = DetachedLenses::default();
    let groups = ReferenceGroups::open(&f.dir.path().join("groups")).unwrap();
    let group = groups
        .create("组", &mut [pin(&f.a_lens, &f.a_images[1], 0)])
        .unwrap();
    f.a.set_safe_mode(true);
    let status = resolve(&group, &f.references(&detached, true));
    assert_eq!(status[0].state, MemberState::Available { sealed: true });
}

#[test]
fn unavailable_members_keep_their_layout_and_say_why() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let groups = ReferenceGroups::open(&f.dir.path().join("groups")).unwrap();
    let mut stranger = pin(&f.a_lens, &f.a_images[0], 30);
    stranger.content = match stranger.content {
        kinshoko_core::desktop::PinContent::Reference {
            image_id,
            source_width,
            source_height,
            ..
        } => kinshoko_core::desktop::PinContent::Reference {
            library_id: "not-registered".into(),
            image_id,
            source_width,
            source_height,
        },
        other => other,
    };
    let group = groups
        .create(
            "组",
            &mut [
                f.b_pin(&detached, 0, 10),
                stranger,
                pin(&f.a_lens, &f.a_images[0], 20),
                pin(&f.a_lens, &f.a_images[1], 40),
            ],
        )
        .unwrap();
    detached.clear();

    // B 所在的移动盘拔掉了（目录不在了）。
    std::fs::rename(&f.b.root, f.dir.path().join("elsewhere")).unwrap();
    // A 的第二张图原文件丢了。
    std::fs::remove_file(f.a_lens.original_path(&f.a_images[1]).unwrap()).unwrap();

    let status = resolve(&group, &f.references(&detached, true));
    let reasons: Vec<_> = status
        .iter()
        .map(|s| match &s.state {
            MemberState::Unavailable { reason, message } => {
                assert!(!message.is_empty());
                Some(reason.clone())
            }
            MemberState::Available { .. } => None,
        })
        .collect();
    assert!(matches!(
        reasons[0],
        Some(UnavailableReason::LibraryUnavailable { .. })
    ));
    assert_eq!(reasons[1], Some(UnavailableReason::LibraryNotRegistered));
    assert_eq!(reasons[2], None);
    assert_eq!(reasons[3], Some(UnavailableReason::OriginalMissing));

    // 成员与布局原样保留，照样能打开成钉图（钉图显示原因）。
    let again = groups.get(&group.id).unwrap();
    assert_eq!(again, group);
    let pins = again.pins();
    assert_eq!(pins.len(), 4);
    assert_eq!(pins[0].placement.x, 10);

    // 移动盘接回后就能用：打不开的不缓存。
    std::fs::rename(f.dir.path().join("elsewhere"), &f.b.root).unwrap();
    let status = resolve(&group, &f.references(&detached, true));
    assert_eq!(status[0].state, MemberState::Available { sealed: false });
}

#[test]
fn a_member_whose_image_is_gone_from_the_library_is_marked_missing() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let refs = f.references(&detached, true);
    assert_eq!(
        refs.image(&f.a.info().id, "no-such-image").unwrap_err(),
        UnavailableReason::ImageMissing
    );
    assert_eq!(
        refs.image(&f.b.id, "no-such-image").unwrap_err(),
        UnavailableReason::ImageMissing
    );
}

#[test]
fn members_in_the_trash_stay_usable() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    f.a.edit(&[f.a_images[0].clone()], &[ImageEdit::Delete])
        .unwrap();
    let refs = f.references(&detached, true);
    assert!(refs.image(&f.a.info().id, &f.a_images[0]).is_ok());
}

#[test]
fn a_library_registered_at_a_place_now_holding_another_library_is_unavailable() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let mut registry = f.registry.clone();
    registry[1].root = f.a.info().root.clone();
    let refs = References {
        current: None,
        registry: &registry,
        detached: &detached,
        safe_mode: true,
    };
    assert!(matches!(
        refs.image(&f.b.id, &f.b_images[0]),
        Err(UnavailableReason::LibraryUnavailable { .. })
    ));
}

#[test]
fn permanent_delete_preview_finds_the_groups_using_the_images() {
    let f = Fixture::new();
    let detached = DetachedLenses::default();
    let groups = ReferenceGroups::open(&f.dir.path().join("groups")).unwrap();
    let face = groups
        .create(
            "脸",
            &mut [
                pin(&f.a_lens, &f.a_images[0], 0),
                pin(&f.a_lens, &f.a_images[0], 10),
                f.b_pin(&detached, 0, 0),
            ],
        )
        .unwrap();
    groups
        .create("手", &mut [pin(&f.a_lens, &f.a_images[1], 0)])
        .unwrap();

    let a = f.a.info().id.clone();
    let used = groups
        .groups_using(&a, &[f.a_images[0].clone(), "other".into()])
        .unwrap();
    assert_eq!(
        used,
        vec![GroupUsage {
            group_id: face.id.clone(),
            name: "脸".into(),
            image_ids: vec![f.a_images[0].clone()],
        }]
    );
    // B 里同样 id 的图不算（按资料库＋参考图）。
    assert!(
        groups
            .groups_using(&f.b.id, &[f.a_images[0].clone()])
            .unwrap()
            .is_empty()
    );
}
