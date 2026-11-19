//! 桌面上的参考组（#588、#590）：第一次打开时从 `pins.json` 迁移，以及参考组文件格式的兼容。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。

#[path = "support/desk.rs"]
mod desk;

use desk::{TestDesk, reference_pin, screen, shot};
use kinshoko_core::reference_groups::ReferenceGroup;

fn reread(t: &TestDesk, id: &str) -> ReferenceGroup {
    t.groups().get(id).unwrap()
}

fn ids(list: &[kinshoko_core::reference_groups::GroupSummary]) -> Vec<String> {
    list.iter().map(|s| s.id.clone()).collect()
}

#[test]
fn the_first_open_turns_old_pins_into_a_group_and_makes_old_groups_favorites() {
    // 旧数据：一个参考组、桌面上两张钉图（一张来自那个参考组，一张截图）。
    let mut old_group = String::new();
    let mut old_bytes = Vec::new();
    let mut t = TestDesk::with(|root| {
        let groups = desk::groups(root);
        let mut pins = vec![reference_pin("old", 10)];
        let group = groups.create("旧参考组", &mut pins).unwrap();
        old_group = group.id.clone();
        old_bytes =
            std::fs::read(root.join(format!("reference-groups/{}.json", group.id))).unwrap();

        let mut history =
            kinshoko_core::desktop::CaptureHistory::open(&root.join("captures")).unwrap();
        let entry = history.add(&shot(2)).unwrap();
        let mut store = kinshoko_core::desktop::PinStore::open(root).unwrap();
        let mut from_group = pins.remove(0);
        from_group.set_opacity(0.5);
        store.put(from_group);
        store.put(desk::capture_pin("cap", &entry.id));
        // 截图已不在截图历史中的钉图：迁移时去掉。
        store.put(desk::capture_pin("gone", "no-such-capture"));
        store.save().unwrap();
    });

    let migrated = t.desk.group().unwrap().clone();
    assert!(migrated.is_unnamed());
    assert_eq!(migrated.members.len(), 2);
    assert_eq!(migrated.members[0].opacity, 0.5, "透明度随成员保存");
    assert_eq!(
        std::fs::read(t.group_file(&old_group)).unwrap(),
        old_bytes,
        "旧参考组文件一个字节都不改"
    );
    let lists = t.desk.lists().unwrap();
    assert_eq!(
        ids(&lists.favorites),
        [old_group.clone()],
        "旧参考组都算常用"
    );
    assert_eq!(ids(&lists.recent), std::slice::from_ref(&migrated.id));

    let entries_before = t.history.entries().len();
    let opened = t.desk.restore(&mut t.history, &[screen()]);
    assert_eq!(opened.pins.len(), 2);
    for pin in &opened.pins {
        assert_eq!(
            pin.member.as_ref().unwrap().group_id,
            migrated.id,
            "旧的成员关联丢弃"
        );
    }
    let capture = opened.pins.iter().find_map(|p| p.capture_id()).unwrap();
    assert_eq!(
        t.history.entries().len(),
        entries_before,
        "复用原来那条截图"
    );
    let linked = t.history.linked_members(capture);
    assert!(
        linked.iter().any(|m| m.group_id == migrated.id),
        "截图历史记着迁移出的成员，收藏能改连：{linked:?}"
    );
}

#[test]
fn migrating_twice_after_an_interruption_gives_the_same_result() {
    let mut old_group = String::new();
    let mut t = TestDesk::with(|root| {
        let mut pins = vec![reference_pin("x", 10)];
        old_group = desk::groups(root).create("旧", &mut pins).unwrap().id;
        let mut store = kinshoko_core::desktop::PinStore::open(root).unwrap();
        store.put(reference_pin("a", 10));
        store.put(reference_pin("b", 20));
        store.save().unwrap();
    });
    let first = t.desk.group().unwrap().clone();
    // 像写完参考组、还没写桌面状态时断电一样：去掉桌面状态再打开。
    std::fs::remove_file(t.root.join("desk.json")).unwrap();
    t.restart();
    let second = t.desk.group().unwrap().clone();
    assert_eq!(second.id, first.id, "不产生重复的参考组");
    assert_eq!(second.members.len(), 2, "不丢钉图");
    assert_eq!(t.groups().list().unwrap().len(), 2);
    assert_eq!(
        ids(&t.desk.lists().unwrap().favorites),
        [old_group],
        "迁移出的那个不算常用"
    );
}

#[test]
fn an_old_named_library_only_group_keeps_format_version_one_and_its_fields() {
    let mut t = TestDesk::new();
    let mut pins = vec![reference_pin("a", 10)];
    let old = t.groups().create("手", &mut pins).unwrap();
    let old_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(t.group_file(&old.id)).unwrap()).unwrap();

    // 摆上桌面、挪一下、落盘：钉着与没有日期都不写出，字段与旧入口写出的完全相同。
    t.desk.switch_to(&old.id, &mut t.history).unwrap();
    let pin = t.desk.pins()[0].id.clone();
    t.desk.edit(&pin, |p| p.move_to(30, 40));
    t.desk.flush().unwrap();
    let text = std::fs::read_to_string(t.group_file(&old.id)).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["formatVersion"], 1);
    let keys = |v: &serde_json::Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(keys(&json), keys(&old_json));
    assert_eq!(
        keys(&json["members"][0]),
        keys(&old_json["members"][0]),
        "{text}"
    );
    assert_eq!(json["members"][0]["placement"]["x"], 30);

    // 关掉：只多一个 pinned: false。
    t.desk.close(&pin, &mut t.history);
    t.desk.flush().unwrap();
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(t.group_file(&old.id)).unwrap()).unwrap();
    assert_eq!(json["formatVersion"], 1);
    assert_eq!(json["members"][0]["pinned"], false);
}

#[test]
fn an_unnamed_group_is_written_with_a_newer_format_version() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(t.group_file(&id)).unwrap()).unwrap();
    assert_eq!(
        json["formatVersion"], 3,
        "旧版本读到时提示升级，而不是“没有名称”"
    );
    let group = reread(&t, &id);
    assert!(group.package_file_stem().starts_with("kinshoko-"));
}

struct NoLibraries;

impl kinshoko_core::reference_groups::ReferenceSource for NoLibraries {
    fn lens(
        &self,
        _: &str,
    ) -> Result<
        kinshoko_core::library::ReferenceLens,
        kinshoko_core::reference_groups::UnavailableReason,
    > {
        Err(kinshoko_core::reference_groups::UnavailableReason::LibraryNotRegistered)
    }
}

#[test]
fn a_reference_group_package_leaves_out_opacity_lock_and_pinned() {
    let mut t = TestDesk::new();
    let keep = t.pin_capture("k", 5);
    let c = t.pin_capture("c", 6);
    t.desk.edit(&c.id, |p| {
        p.set_opacity(0.3);
        p.locked = true;
    });
    t.desk.close(&keep.id, &mut t.history);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    let out = t.root.join("out.kinshoko-group");
    t.groups().export_package(&id, &NoLibraries, &out).unwrap();
    let manifest = kinshoko_core::reference_groups::read_package(&out).unwrap();
    for member in &manifest.group.members {
        assert_eq!(
            (member.opacity, member.locked, member.pinned),
            (1.0, false, true)
        );
    }
    assert!(manifest.group.is_unnamed(), "没有名称的参考组也能导出");
    let capture = reread(&t, &id)
        .members
        .into_iter()
        .find(|m| m.pinned)
        .unwrap();
    assert_eq!((capture.opacity, capture.locked), (0.3, true));
}
