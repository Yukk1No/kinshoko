//! 截图历史条目记得由它而来的组内截图成员（#270）：钉图关掉后从截图历史收藏，参考组成员照样改为
//! 引用图库那张，组内副本删除。关联失效（截图历史条目被丢弃、成员已移出、参考组已删除）时略过；
//! 同一张截图进了几个参考组时都改连。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::desktop::{
    CaptureHistory, GroupMemberRef, HISTORY_LIMIT, PinContent, Placement, SavedPin, Screenshot,
};
use kinshoko_core::reference_groups::{MemberSource, ReferenceGroup, ReferenceGroups};

fn shot(seed: u8) -> Screenshot {
    Screenshot {
        image: RgbaImage::from_fn(30, 20, |x, y| image::Rgba([seed, x as u8, y as u8, 255])),
        icc: None,
    }
}

fn capture_pin(capture_id: &str) -> SavedPin {
    SavedPin {
        id: "p".into(),
        content: PinContent::Capture {
            capture_id: capture_id.into(),
        },
        crop: None,
        width: 30,
        height: 20,
        placement: Placement {
            x: 40,
            ..Default::default()
        },
        opacity: 1.0,
        locked: false,
        member: None,
    }
}

struct Desk {
    _dir: tempfile::TempDir,
    history: CaptureHistory,
    groups: ReferenceGroups,
    library: Library,
}

impl Desk {
    fn new() -> Desk {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        Desk {
            history: CaptureHistory::open(&root.join("captures")).unwrap(),
            groups: ReferenceGroups::open(&root.join("reference-groups")).unwrap(),
            library: Library::create(&root.join("library"), "资料库").unwrap(),
            _dir: dir,
        }
    }

    /// 把截图历史条目 `capture_id` 钉到桌面，只存在新参考组 `name` 里，然后关掉钉图。
    fn keep_in_new_group(&mut self, name: &str, capture_id: &str) -> ReferenceGroup {
        let mut pins = [capture_pin(capture_id)];
        let keep = [self.history.group_capture(capture_id).unwrap()];
        let group = self
            .groups
            .create_with_captures(name, &mut pins, &keep)
            .unwrap();
        self.groups.link_captures(&mut self.history, &pins);
        group
    }

    /// 从截图历史收藏（钉图早已关掉），再按关联改连参考组。
    fn collect_from_history(&mut self, capture_id: &str) -> Vec<GroupMemberRef> {
        let collected = self.history.collect(capture_id, &self.library).unwrap();
        self.groups
            .relink_collected(&mut self.history, capture_id, &collected)
    }

    fn source(&self, group: &ReferenceGroup) -> MemberSource {
        self.groups.get(&group.id).unwrap().members[0]
            .source
            .clone()
    }
}

fn member(group: &ReferenceGroup) -> GroupMemberRef {
    GroupMemberRef {
        group_id: group.id.clone(),
        member_id: group.members[0].id.clone(),
    }
}

#[test]
fn collecting_from_history_after_the_pin_closed_points_the_member_at_the_library() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(1)).unwrap();
    let group = desk.keep_in_new_group("一次性", &entry.id);
    let copy = desk
        .groups
        .capture_path(&group.id, &group.members[0].id)
        .unwrap();
    assert!(copy.is_file());

    let relinked = desk.collect_from_history(&entry.id);

    assert_eq!(relinked, vec![member(&group)]);
    let library_id = desk.library.info().id.clone();
    assert!(matches!(
        desk.source(&group),
        MemberSource::Library { library_id: l, .. } if l == library_id
    ));
    let after = desk.groups.get(&group.id).unwrap();
    assert_eq!(after.members[0].placement, group.members[0].placement);
    assert!(!copy.exists(), "组内副本删除");
    // 关联用过即去掉：再收藏一次什么都不改。
    assert!(desk.collect_from_history(&entry.id).is_empty());
}

#[test]
fn every_group_holding_the_same_capture_is_relinked() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(2)).unwrap();
    let a = desk.keep_in_new_group("甲", &entry.id);
    let b = desk.keep_in_new_group("乙", &entry.id);

    let mut relinked = desk.collect_from_history(&entry.id);
    relinked.sort_by(|x, y| x.group_id.cmp(&y.group_id));
    let mut expected = vec![member(&a), member(&b)];
    expected.sort_by(|x, y| x.group_id.cmp(&y.group_id));

    assert_eq!(relinked, expected);
    for g in [&a, &b] {
        assert!(matches!(desk.source(g), MemberSource::Library { .. }));
    }
}

#[test]
fn a_removed_member_or_deleted_group_is_skipped() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(3)).unwrap();
    let gone = desk.keep_in_new_group("删掉的", &entry.id);
    let emptied = desk.keep_in_new_group("移出成员的", &entry.id);
    let kept = desk.keep_in_new_group("留着的", &entry.id);
    desk.groups.delete(&gone.id).unwrap();
    desk.groups
        .remove_member(&emptied.id, &emptied.members[0].id)
        .unwrap();

    assert_eq!(desk.collect_from_history(&entry.id), vec![member(&kept)]);
    assert!(desk.groups.get(&gone.id).is_err(), "删掉的参考组不会复活");
    assert!(desk.groups.get(&emptied.id).unwrap().members.is_empty());
}

#[test]
fn a_discarded_history_entry_drops_its_links_and_reopening_the_group_links_the_new_entry() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(4)).unwrap();
    let group = desk.keep_in_new_group("一次性", &entry.id);
    for seed in 0..HISTORY_LIMIT {
        desk.history.add(&shot(10 + seed as u8)).unwrap();
    }
    assert!(desk.history.entry(&entry.id).is_none(), "旧条目已丢弃");
    assert!(matches!(desk.source(&group), MemberSource::Capture { .. }));

    // 打开参考组：截图放回截图历史成为新条目，并记得它来自哪个成员。
    let opened = desk.groups.open_pins(&group, &mut desk.history, |_| false);
    let reopened = opened.pins[0].capture_id().unwrap().to_owned();
    assert_ne!(reopened, entry.id);
    desk.history.unpin(&reopened);

    assert_eq!(desk.collect_from_history(&reopened), vec![member(&group)]);
    assert!(matches!(desk.source(&group), MemberSource::Library { .. }));
}
