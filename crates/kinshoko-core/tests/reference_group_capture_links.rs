//! 截图历史条目记得由它而来的组内截图成员（#270）：钉图关掉后从截图历史收藏，参考组成员照样改为
//! 引用图库那张，组内副本删除。关联失效（截图历史条目被丢弃、成员已移出、参考组已删除）时略过；
//! 同一张截图进了几个参考组时都改连；某个参考组读写失败时其他照常改连，失败的关联留着下次再试。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。

use image::RgbaImage;
use kinshoko_core::Library;
use std::fs;
use std::path::PathBuf;

use kinshoko_core::desktop::{
    CaptureHistory, CollectedCapture, GroupMemberRef, HISTORY_LIMIT, PinContent, Placement,
    SavedPin, Screenshot,
};
use kinshoko_core::reference_groups::{
    GroupError, MemberSource, ReferenceGroup, ReferenceGroups, RelinkReport,
};

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
    dir: tempfile::TempDir,
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
            dir,
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

    /// 从截图历史收藏（钉图早已关掉），再按关联改连参考组。返回改连了的成员。
    fn collect_from_history(&mut self, capture_id: &str) -> Vec<GroupMemberRef> {
        self.collect(capture_id).1.relinked
    }

    /// 同上，交回收藏成的参考图与完整的改连结果。
    fn collect(&mut self, capture_id: &str) -> (CollectedCapture, RelinkReport) {
        let collected = self.history.collect(capture_id, &self.library).unwrap();
        let report = self.relink(capture_id, &collected);
        (collected, report)
    }

    /// 按关联再改连一次（下次收藏时的重试）。
    fn relink(&mut self, capture_id: &str, collected: &CollectedCapture) -> RelinkReport {
        self.groups
            .relink_collected(&mut self.history, capture_id, collected)
    }

    /// 参考组文件。
    fn group_file(&self, group: &ReferenceGroup) -> PathBuf {
        self.dir
            .path()
            .join("reference-groups")
            .join(format!("{}.json", group.id))
    }

    /// 截图历史索引写入时用的临时文件。
    fn history_tmp(&self) -> PathBuf {
        self.dir.path().join("captures").join("history.json.tmp")
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

/// 参考组文件读不了：换成同名目录，`fs::read` 报的不是“不存在”。
fn make_unreadable(path: &PathBuf) -> Vec<u8> {
    let bytes = fs::read(path).unwrap();
    fs::remove_file(path).unwrap();
    fs::create_dir(path).unwrap();
    bytes
}

fn make_readable(path: &PathBuf, bytes: &[u8]) {
    fs::remove_dir(path).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn a_group_that_cannot_be_read_keeps_its_link_while_the_others_are_relinked() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(5)).unwrap();
    let a = desk.keep_in_new_group("甲", &entry.id);
    let b = desk.keep_in_new_group("乙", &entry.id);
    let b_file = desk.group_file(&b);
    let bytes = make_unreadable(&b_file);

    let (collected, report) = desk.collect(&entry.id);

    assert_eq!(report.relinked, vec![member(&a)]);
    assert!(report.skipped.is_empty(), "读不了不当作已删除");
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].member, member(&b));
    assert!(matches!(report.failed[0].reason, GroupError::Io(_)));
    assert_eq!(report.unlink_error, None);
    assert!(matches!(desk.source(&a), MemberSource::Library { .. }));
    assert_eq!(desk.history.linked_members(&entry.id), vec![member(&b)]);

    // 恢复后再试：只补乙，甲不再出现。
    make_readable(&b_file, &bytes);
    let retry = desk.relink(&entry.id, &collected);
    assert_eq!(retry.relinked, vec![member(&b)]);
    assert!(retry.skipped.is_empty() && retry.failed.is_empty());
    assert!(matches!(desk.source(&b), MemberSource::Library { .. }));
    assert!(desk.history.linked_members(&entry.id).is_empty());
}

/// Windows 上目标是只读文件时替换不了，参考组写不进。
#[cfg(windows)]
#[test]
#[allow(clippy::permissions_set_readonly_false)]
fn a_group_that_cannot_be_written_keeps_its_link_while_the_others_are_relinked() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(6)).unwrap();
    let a = desk.keep_in_new_group("甲", &entry.id);
    let b = desk.keep_in_new_group("乙", &entry.id);
    let b_file = desk.group_file(&b);
    let set_readonly = |on: bool| {
        let mut perms = fs::metadata(&b_file).unwrap().permissions();
        perms.set_readonly(on);
        fs::set_permissions(&b_file, perms).unwrap();
    };
    set_readonly(true);

    let (collected, report) = desk.collect(&entry.id);

    assert_eq!(report.relinked, vec![member(&a)]);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].member, member(&b));
    assert!(matches!(desk.source(&b), MemberSource::Capture { .. }));
    assert!(
        desk.groups
            .capture_path(&b.id, &b.members[0].id)
            .unwrap()
            .is_file(),
        "写不进时组内截图留着"
    );
    assert_eq!(desk.history.linked_members(&entry.id), vec![member(&b)]);

    set_readonly(false);
    let retry = desk.relink(&entry.id, &collected);
    assert_eq!(retry.relinked, vec![member(&b)]);
    assert!(retry.failed.is_empty());
    assert!(matches!(desk.source(&b), MemberSource::Library { .. }));
}

#[test]
fn links_that_cannot_be_removed_from_the_index_are_reported_and_skipped_next_time() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(7)).unwrap();
    let group = desk.keep_in_new_group("一次性", &entry.id);
    let collected = desk.history.collect(&entry.id, &desk.library).unwrap();
    // 索引的临时文件位置被目录占着，写不进索引。
    fs::create_dir(desk.history_tmp()).unwrap();

    let report = desk.relink(&entry.id, &collected);

    assert_eq!(report.relinked, vec![member(&group)]);
    assert!(report.unlink_error.is_some());
    assert_eq!(desk.history.linked_members(&entry.id), vec![member(&group)]);

    fs::remove_dir(desk.history_tmp()).unwrap();
    let retry = desk.relink(&entry.id, &collected);
    assert!(retry.relinked.is_empty(), "已改连的成员不再改连");
    assert_eq!(retry.skipped, vec![member(&group)]);
    assert_eq!(retry.unlink_error, None);
    assert!(desk.history.linked_members(&entry.id).is_empty());
}

#[test]
fn stale_links_are_skipped_once_and_then_forgotten() {
    let mut desk = Desk::new();
    let entry = desk.history.add(&shot(8)).unwrap();
    let gone = desk.keep_in_new_group("删掉的", &entry.id);
    let emptied = desk.keep_in_new_group("移出成员的", &entry.id);
    desk.groups.delete(&gone.id).unwrap();
    desk.groups
        .remove_member(&emptied.id, &emptied.members[0].id)
        .unwrap();

    let (collected, report) = desk.collect(&entry.id);
    assert!(report.relinked.is_empty() && report.failed.is_empty());
    let mut skipped = report.skipped;
    skipped.sort_by(|x, y| x.group_id.cmp(&y.group_id));
    let mut expected = vec![member(&gone), member(&emptied)];
    expected.sort_by(|x, y| x.group_id.cmp(&y.group_id));
    assert_eq!(skipped, expected);

    assert_eq!(desk.relink(&entry.id, &collected), RelinkReport::default());
}
