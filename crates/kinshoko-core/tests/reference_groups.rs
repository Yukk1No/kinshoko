//! 参考组（#66，ADR-0002）：独立于资料库保存的带版本 JSON，成员按“资料库＋参考图”引用，
//! 各自保存裁切、翻转、旋转、位置、尺寸与缩放。经 `kinshoko_core::reference_groups` 的对外接口，
//! 用临时目录里的真文件。

use kinshoko_core::desktop::{PinContent, Placement, Region, SavedPin};
use kinshoko_core::library::ReferenceImage;
use kinshoko_core::reference_groups::{GroupError, ReferenceGroups};

fn image(id: &str, width: u32, height: u32) -> ReferenceImage {
    ReferenceImage {
        id: id.into(),
        width,
        height,
        sealed: false,
    }
}

fn region(x: u32, y: u32, width: u32, height: u32) -> Region {
    Region {
        x,
        y,
        width,
        height,
    }
}

fn pin(id: &str, library: &str, img: &str, crop: Option<Region>, x: i32) -> SavedPin {
    SavedPin::reference(
        id,
        library,
        &image(img, 800, 600),
        crop,
        Placement {
            x,
            y: 40,
            scale: 0.5,
            flip_h: true,
            flip_v: false,
            rotation: 1,
        },
    )
    .unwrap()
}

fn capture_pin() -> SavedPin {
    SavedPin {
        id: "cap".into(),
        content: PinContent::Capture {
            capture_id: "c1".into(),
        },
        crop: None,
        width: 10,
        height: 10,
        placement: Placement::default(),
        opacity: 1.0,
        locked: false,
        member: None,
    }
}

#[test]
fn a_saved_group_reopens_with_each_members_crop_and_layout() {
    let dir = tempfile::tempdir().unwrap();
    let mut pins = [
        pin("p1", "lib-a", "img-1", Some(region(10, 20, 300, 200)), 100),
        pin("p2", "lib-b", "img-2", None, 700),
    ];
    let saved = {
        let groups = ReferenceGroups::open(dir.path()).unwrap();
        groups.create("头发参考", &mut pins).unwrap()
    };
    assert_eq!(saved.name, "头发参考");
    assert_eq!(saved.members.len(), 2);

    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let group = groups.get(&saved.id).unwrap();
    assert_eq!(group, saved);
    let reopened = group.pins();
    assert_eq!(reopened.len(), 2);
    for (again, before) in reopened.iter().zip(&pins) {
        assert_eq!(again.content, before.content);
        assert_eq!(again.crop, before.crop);
        assert_eq!((again.width, again.height), (before.width, before.height));
        assert_eq!(again.placement, before.placement);
        assert_ne!(again.id, before.id, "打开参考组得到新的钉图");
        let member = again.member.as_ref().expect("钉图记得来自哪个成员");
        assert_eq!(member.group_id, group.id);
    }
}

#[test]
fn opacity_and_lock_stay_on_the_desktop() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let mut p = pin("p1", "lib-a", "img-1", None, 0);
    p.opacity = 0.3;
    p.locked = true;
    let group = groups.create("组", &mut [p]).unwrap();
    let again = &group.pins()[0];
    assert_eq!(again.opacity, 1.0);
    assert!(!again.locked);
}

#[test]
fn screen_captures_are_not_saved_into_a_group() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let group = groups
        .create(
            "组",
            &mut [capture_pin(), pin("p1", "lib-a", "img-1", None, 0)],
        )
        .unwrap();
    assert_eq!(group.members.len(), 1);
    assert_eq!(
        groups.create("空", &mut [capture_pin()]),
        Err(GroupError::NoMembers)
    );
}

#[test]
fn groups_are_listed_renamed_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let a = groups
        .create("A", &mut [pin("p1", "lib-a", "img-1", None, 0)])
        .unwrap();
    let b = groups
        .create(
            "B",
            &mut [
                pin("p2", "lib-a", "img-1", None, 0),
                pin("p3", "lib-b", "img-2", None, 0),
            ],
        )
        .unwrap();

    groups.rename(&a.id, "  手部  ").unwrap();
    assert_eq!(groups.get(&a.id).unwrap().name, "手部");
    assert_eq!(groups.rename(&a.id, "  "), Err(GroupError::InvalidName));

    let list = groups.list().unwrap();
    let names: Vec<_> = list
        .iter()
        .map(|s| (s.name.as_str(), s.member_count))
        .collect();
    assert!(
        names.contains(&("手部", 1)) && names.contains(&("B", 2)),
        "{names:?}"
    );
    let b_summary = list.iter().find(|s| s.id == b.id).unwrap();
    assert_eq!(b_summary.library_ids, vec!["lib-a", "lib-b"]);

    groups.delete(&a.id).unwrap();
    assert_eq!(groups.get(&a.id), Err(GroupError::UnknownGroup));
    assert_eq!(groups.delete(&a.id), Err(GroupError::UnknownGroup));
    assert_eq!(groups.list().unwrap().len(), 1);
}

#[test]
fn the_same_image_in_two_groups_keeps_independent_member_state() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let face = groups
        .create(
            "脸",
            &mut [pin("p1", "lib-a", "img-1", Some(region(0, 0, 100, 100)), 0)],
        )
        .unwrap();
    let hand = groups
        .create(
            "手",
            &mut [pin(
                "p2",
                "lib-a",
                "img-1",
                Some(region(400, 300, 200, 150)),
                0,
            )],
        )
        .unwrap();

    // 打开“脸”，移动、缩放、旋转它的钉图，存回“脸”。
    let mut opened = face.pins();
    opened[0].move_to(900, 900);
    opened[0].rotate(1);
    opened[0].flip(false);
    groups.save_pins(&face.id, &mut opened).unwrap();

    let face_now = groups.get(&face.id).unwrap();
    assert_eq!(face_now.members.len(), 1, "存回原成员，不另加");
    assert_eq!(face_now.members[0].id, face.members[0].id);
    assert_eq!(face_now.members[0].placement, opened[0].placement);
    assert_eq!(groups.get(&hand.id).unwrap(), hand, "另一个参考组不受影响");
}

#[test]
fn saving_pins_into_a_group_adds_new_pins_and_keeps_members_not_on_the_desktop() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let group = groups
        .create(
            "组",
            &mut [
                pin("p1", "lib-a", "img-1", None, 0),
                pin("p2", "lib-a", "img-2", None, 0),
            ],
        )
        .unwrap();
    let opened = group.pins();
    // 只有第一个成员的钉图还开着，另钉了一张新图；第二个成员不在桌面上也保留。
    let fresh = pin("p9", "lib-c", "img-9", None, 5);
    let saved = groups
        .save_pins(&group.id, &mut [opened[0].clone(), fresh, capture_pin()])
        .unwrap();
    assert_eq!(saved.members.len(), 3);
    assert_eq!(saved.members[1], group.members[1]);
    assert_eq!(saved.members[2].library_id, "lib-c");
    assert_eq!(
        groups.save_pins("nope", &mut [opened[0].clone()]),
        Err(GroupError::UnknownGroup)
    );
}

#[test]
fn a_member_can_be_removed_from_a_group() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let group = groups
        .create(
            "组",
            &mut [
                pin("p1", "lib-a", "img-1", None, 0),
                pin("p2", "lib-a", "img-2", None, 0),
            ],
        )
        .unwrap();
    let left = groups
        .remove_member(&group.id, &group.members[0].id)
        .unwrap();
    assert_eq!(left.members, vec![group.members[1].clone()]);
}

#[test]
fn the_group_file_is_versioned_json_independent_of_libraries() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let group = groups
        .create(
            "组",
            &mut [pin("p1", "lib-a", "img-1", Some(region(1, 2, 3, 4)), 0)],
        )
        .unwrap();
    let path = dir.path().join(format!("{}.json", group.id));
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(json["format"], "kinshoko.reference-group");
    assert_eq!(json["formatVersion"], 1);
    let member = &json["members"][0];
    assert_eq!(member["libraryId"], "lib-a");
    assert_eq!(member["imageId"], "img-1");
    assert_eq!(member["sourceWidth"], 800);
    assert_eq!(member["crop"]["width"], 3);
    assert_eq!(member["placement"]["rotation"], 1);
    assert!(
        std::fs::read_dir(dir.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")),
        "原子写入，不留临时文件"
    );
}

#[test]
fn unreadable_or_newer_group_files_are_reported_not_silently_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let good = groups
        .create("好", &mut [pin("p1", "lib-a", "img-1", None, 0)])
        .unwrap();
    std::fs::write(dir.path().join("broken.json"), b"{not json").unwrap();
    let mut newer: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(format!("{}.json", good.id))).unwrap(),
    )
    .unwrap();
    newer["formatVersion"] = 99.into();
    newer["id"] = "future".into();
    std::fs::write(
        dir.path().join("future.json"),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    // 局部超出原图的成员：格式不对。
    let mut bad_crop: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(format!("{}.json", good.id))).unwrap(),
    )
    .unwrap();
    bad_crop["id"] = "badcrop".into();
    bad_crop["members"][0]["crop"] =
        serde_json::json!({"x": 700, "y": 0, "width": 200, "height": 10});
    std::fs::write(
        dir.path().join("badcrop.json"),
        serde_json::to_vec(&bad_crop).unwrap(),
    )
    .unwrap();

    let list = groups.list().unwrap();
    assert_eq!(list.len(), 4);
    let by_id = |id: &str| list.iter().find(|s| s.id == id).unwrap();
    assert!(by_id(&good.id).problem.is_none());
    assert!(by_id("broken").problem.is_some());
    assert!(by_id("future").problem.is_some());
    assert!(by_id("badcrop").problem.is_some());
    assert_eq!(
        groups.get("future"),
        Err(GroupError::UnsupportedVersion(99))
    );
    assert!(matches!(groups.get("badcrop"), Err(GroupError::Invalid(_))));
}

#[test]
fn pins_remember_the_member_they_were_saved_as() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let mut pins = [pin("p1", "lib-a", "img-1", None, 0), capture_pin()];
    let a = groups.create("A", &mut pins).unwrap();
    let member = pins[0].member.clone().expect("存进参考组后记得成员");
    assert_eq!(member.group_id, a.id);
    assert_eq!(member.member_id, a.members[0].id);
    assert_eq!(pins[1].member, None, "截图不进组");

    // 同一张钉图再存进另一个参考组：加为那边的新成员，之后记得新的成员；A 不变。
    let b = groups
        .create("B", &mut [pin("p2", "lib-a", "img-2", None, 0)])
        .unwrap();
    let b = groups.save_pins(&b.id, &mut pins).unwrap();
    assert_eq!(b.members.len(), 2);
    assert_eq!(pins[0].member.as_ref().unwrap().group_id, b.id);
    assert_eq!(groups.get(&a.id).unwrap(), a);

    // 再存一次 B：更新那个成员，不重复添加。
    pins[0].move_to(500, 500);
    let b = groups.save_pins(&b.id, &mut pins).unwrap();
    assert_eq!(b.members.len(), 2);
    assert_eq!(b.members[1].placement.x, 500);
}
