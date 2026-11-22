//! 参考组（#66，ADR-0002）：独立于资料库保存的带版本 JSON，成员按“资料库＋参考图”引用，
//! 各自保存裁切、翻转、旋转、位置、尺寸与缩放。经 `kinshoko_core::reference_groups` 的对外接口，
//! 用临时目录里的真文件；参考组经桌面上的参考组存出（`support/group_fixture.rs`）。

#[path = "support/group_fixture.rs"]
mod group_fixture;
use group_fixture::GroupFixture;

use kinshoko_core::desktop::{Placement, Region, SavedPin};
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

#[test]
fn groups_are_listed_renamed_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let a = groups
        .save_group("A", &mut [pin("p1", "lib-a", "img-1", None, 0)])
        .unwrap();
    let b = groups
        .save_group(
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
fn a_member_can_be_removed_from_a_group() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let group = groups
        .save_group(
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
        .save_group(
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
        .save_group("好", &mut [pin("p1", "lib-a", "img-1", None, 0)])
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

/// 删除参考组可撤销（#480）：先移到回收位置，撤销后名称、成员、每个成员的裁切与摆放、组内截图都与删除前一致；
/// 回收位置里的不出现在列表中，过期清理或重新打开后不留任何东西。
#[test]
fn a_deleted_group_comes_back_exactly_until_it_is_purged() {
    let dir = tempfile::tempdir().unwrap();
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    let made = groups
        .save_group(
            "手部",
            &mut [
                pin("p1", "lib-a", "img-1", Some(region(10, 20, 300, 200)), 5),
                pin("p2", "lib-b", "img-2", None, -30),
            ],
        )
        .unwrap();
    let other = groups
        .save_group("别的", &mut [pin("p3", "lib-a", "img-3", None, 0)])
        .unwrap();
    let captures = dir.path().join(format!("{}.captures", made.id));
    std::fs::create_dir_all(&captures).unwrap();
    std::fs::write(captures.join("a.png"), b"shot").unwrap();
    let before = groups.get(&made.id).unwrap();

    groups.trash(&made.id).unwrap();
    assert_eq!(groups.get(&made.id), Err(GroupError::UnknownGroup));
    assert_eq!(groups.list().unwrap().len(), 1);
    assert!(!captures.exists());

    groups.untrash(&made.id).unwrap();
    assert_eq!(groups.get(&made.id).unwrap(), before);
    assert_eq!(std::fs::read(captures.join("a.png")).unwrap(), b"shot");
    assert_eq!(groups.list().unwrap().len(), 2);
    assert_eq!(groups.untrash(&made.id), Err(GroupError::UnknownGroup));

    // 提示过期：清理后撤销不了，也不留文件。
    groups.trash(&made.id).unwrap();
    groups.purge(&made.id).unwrap();
    assert_eq!(groups.untrash(&made.id), Err(GroupError::UnknownGroup));
    assert!(!captures.exists());

    // 程序在撤销提示期间退出：程序启动时清掉回收位置里剩下的，不留垃圾。
    groups.trash(&other.id).unwrap();
    drop(groups);
    let groups = ReferenceGroups::open(dir.path()).unwrap();
    groups.purge_all_trashed().unwrap();
    assert_eq!(groups.untrash(&other.id), Err(GroupError::UnknownGroup));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}
