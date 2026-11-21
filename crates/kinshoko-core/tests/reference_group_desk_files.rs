//! 桌面上的参考组（#588、#590）续：资料库不可用、迁移、文件格式、参考组包、落盘失败，
//! 以及关闭时间、全部钉上、点成员钉出（#588 11-19 晚）。

#[path = "support/desk.rs"]
mod desk;

use desk::{TestDesk, assert_matches, break_state, ids, reference_pin, reread, screen, shot};

#[test]
fn members_of_an_unavailable_library_survive_switching_and_syncing() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_reference("b", 20);
    let id = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    let back = t.desk.switch_to(&id, &mut t.history).unwrap();
    assert_eq!(back.opened.pins.len(), 2, "资料库不在也钉出（显示占位）");
    let pin = back.opened.pins[0].clone();
    t.desk.edit(&pin.id, |p| p.move_to(5, 5));
    t.restart();
    assert_eq!(reread(&t, &id).members.len(), 2);
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

#[test]
fn the_lists_follow_the_desk_before_it_is_saved() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let id = t.desk_id();
    let lists = t.desk.lists().unwrap();
    assert_eq!(lists.on_desk.as_deref(), Some(id.as_str()));
    assert_eq!(
        ids(&lists.recent),
        std::slice::from_ref(&id),
        "钉上第一张就列出"
    );

    t.desk.close(&a.id, &mut t.history);
    let lists = t.desk.lists().unwrap();
    assert_eq!(
        lists.on_desk.as_deref(),
        Some(id.as_str()),
        "关掉最后一张仍在桌面上"
    );
    assert_eq!(ids(&lists.recent), [id], "关掉最后一张，成员还在，照样列出");
}

#[test]
fn a_switch_that_cannot_save_the_desk_state_changes_nothing() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let a = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("b", 20);
    t.desk.flush().unwrap();
    let b = t.desk_id();
    let pins = t.desk.pins().to_vec();

    let state = break_state(&t);
    assert!(t.desk.switch_to(&a, &mut t.history).is_err());
    assert_eq!(t.desk_id(), b, "桌面还是原来那一桌");
    assert_eq!(t.desk.pins(), &pins[..]);

    std::fs::remove_dir_all(&state).unwrap();
    let switched = t.desk.switch_to(&a, &mut t.history).unwrap();
    assert_eq!(switched.closed.len(), 1);
    assert_eq!(t.desk_id(), a);
}

#[test]
fn deleting_the_group_on_the_desk_when_the_desk_state_cannot_be_saved_keeps_it() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_capture("c", 3);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    let captures = t.capture_files(&id);

    let state = break_state(&t);
    assert!(t.desk.discard(&id, &mut t.history).is_err());
    assert_eq!(t.desk_id(), id);
    assert!(t.group_file(&id).exists(), "文件放回原处");
    assert_eq!(t.capture_files(&id), captures, "组内截图也放回");

    std::fs::remove_dir_all(&state).unwrap();
    let switched = t.desk.discard(&id, &mut t.history).unwrap();
    assert!(switched.is_some(), "之后照常能删");
}

#[test]
fn undoing_a_delete_that_cannot_switch_back_can_be_retried() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    t.desk.discard(&id, &mut t.history).unwrap();

    let state = break_state(&t);
    assert!(t.desk.undo_discard(&id, &mut t.history).is_err());
    std::fs::remove_dir_all(&state).unwrap();

    let (_, switched) = t.desk.undo_discard(&id, &mut t.history).unwrap();
    assert!(switched.is_some(), "再撤销一次就摆回桌面");
    assert_eq!(t.desk_id(), id);
    assert_eq!(t.desk.pins().len(), 1);
}

#[test]
fn closing_records_when_and_reopening_clears_it() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    t.desk.close(&a.id, &mut t.history);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    let m = &reread(&t, &id).members[0];
    assert!(!m.pinned);
    assert!(m.closed_at.is_some(), "关掉时记下时间，侧栏按它倒序");
    let member = a.member.as_ref().unwrap().member_id.clone();
    t.desk
        .repin(&member, &mut t.history)
        .unwrap()
        .expect("钉回");
    t.desk.flush().unwrap();
    let m = &reread(&t, &id).members[0];
    assert!(m.pinned && m.closed_at.is_none(), "钉回后不再记关闭时间");
    let raw = std::fs::read_to_string(t.group_file(&id)).unwrap();
    assert!(!raw.contains("closedAt"), "钉着时不写出，旧文件字节不变");
}

#[test]
fn repin_all_opens_every_closed_member_where_it_was() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let b = t.pin_reference("b", 20);
    t.pin_reference("c", 30);
    t.desk.close(&a.id, &mut t.history);
    t.desk.close(&b.id, &mut t.history);
    let opened = t.desk.repin_all(&mut t.history).unwrap();
    assert_eq!(opened.pins.len(), 2);
    assert_eq!(t.desk.pins().len(), 3);
    let xs: Vec<i32> = opened.pins.iter().map(|p| p.placement.x).collect();
    assert!(xs.contains(&10) && xs.contains(&20), "在原位置钉出");
    let group = t.desk.group().unwrap().clone();
    assert_matches(t.desk.pins(), &group);
    assert!(
        t.desk.repin_all(&mut t.history).unwrap().pins.is_empty(),
        "没有已关闭的时什么都不做"
    );
}

#[test]
fn showing_a_member_of_another_group_switches_and_pins_just_it() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let b = t.pin_reference("b", 20);
    let first = t.desk_id();
    t.desk.close(&a.id, &mut t.history);
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("c", 30);
    let second = t.desk_id();

    let closed = a.member.as_ref().unwrap().member_id.clone();
    let shown = t.desk.show_member(&first, &closed, &mut t.history).unwrap();
    assert_eq!(t.desk_id(), first, "切到那个组");
    assert!(shown.switched.is_some());
    assert!(shown.opened.is_some(), "已关闭的那张钉出");
    assert_eq!(t.desk.pins().len(), 2, "那组钉着的照样钉出，加上这一张");
    assert!(shown.pin_id.is_some());

    let pinned = b.member.as_ref().unwrap().member_id.clone();
    let again = t.desk.show_member(&first, &pinned, &mut t.history).unwrap();
    assert!(
        again.switched.is_none() && again.opened.is_none(),
        "已在桌面上、已钉着：只给出它的钉图"
    );
    assert_eq!(
        again.pin_id.as_deref(),
        t.desk
            .pins()
            .iter()
            .find(|p| p.placement.x == 20)
            .map(|p| p.id.as_str())
    );
    assert_ne!(second, first);
}

#[test]
fn switching_to_a_group_saved_on_an_unplugged_monitor_pulls_its_pins_back_onto_the_screen() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 100);
    t.desk.edit(&a.id, |p| p.move_to(9000, 9000));
    let id = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("b", 50);

    let back = t.desk.switch_to(&id, &mut t.history).unwrap();
    assert_eq!(
        back.opened.pins[0].placement.x, 9000,
        "换桌只按存下的位置钉出"
    );
    assert!(t.desk.pull_onto_screen(&[screen()]));
    let pin = t.desk.pins()[0].clone();
    assert!(
        pin.placement.x < 3840 && pin.placement.y < 2160,
        "拉回了屏幕"
    );
    assert!(!t.desk.pull_onto_screen(&[screen()]), "已在屏幕上的不再动");
    t.desk.flush().unwrap();
    assert_eq!(
        reread(&t, &id).members[0].placement,
        pin.placement,
        "成员的摆放跟着改"
    );
}
