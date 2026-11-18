//! 桌面上的参考组（#588、#590）：桌面上始终摆着一个参考组，钉图就是它的成员，改动直接记下；
//! 整桌切换、新建、归档、取出、删除与撤销；第一次打开时从 `pins.json` 迁移。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。资料库 `lib` 不存在：资料库成员一直是
//! “资料库不可用”，照样要留着。

#[path = "support/desk.rs"]
mod desk;

use desk::{TestDesk, reference_pin, screen, shot};
use kinshoko_core::Library;
use kinshoko_core::desktop::{PinContent, SavedPin, Turn};
use kinshoko_core::reference_groups::{GroupMember, MemberSource, ReferenceGroup};

fn reread(t: &TestDesk, id: &str) -> ReferenceGroup {
    t.groups().get(id).unwrap()
}

/// 钉图与成员一一对应，摆放相同。
fn assert_matches(pins: &[SavedPin], group: &ReferenceGroup) {
    assert_eq!(pins.len(), group.members.len(), "钉图与成员一样多");
    for pin in pins {
        let member = pin.member.as_ref().expect("钉图记着成员");
        assert_eq!(member.group_id, group.id);
        let m: &GroupMember = group
            .members
            .iter()
            .find(|m| m.id == member.member_id)
            .expect("成员在参考组里");
        assert_eq!(m.crop, pin.crop);
        assert_eq!(m.placement, pin.placement);
        assert_eq!(m.opacity, pin.opacity);
        assert_eq!(m.locked, pin.locked);
    }
}

#[test]
fn pinning_editing_and_closing_are_recorded_in_the_group_on_the_desk() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 100);
    let b = t.pin_reference("b", 900);
    let c = t.pin_capture("c", 3);
    t.desk.edit(&a.id, |p| p.move_to(120, 260));
    t.desk.edit(&b.id, |p| {
        p.turn(Turn::RotateClockwise);
        p.turn(Turn::FlipHorizontal);
        p.zoom(2.0, (900.0, 40.0));
        p.set_opacity(0.4);
        p.locked = true;
    });
    t.desk.close(&c.id, &mut t.history);
    t.desk.flush().unwrap();

    let id = t.desk.group().id.clone();
    let group = reread(&t, &id);
    assert!(group.is_unnamed(), "不用起名");
    assert_matches(t.desk.pins(), &group);
    assert_eq!(group.members.len(), 2, "关掉的那张不再是成员");
    assert!(
        t.capture_files(&id).is_empty(),
        "关掉的截图钉图不留组内截图"
    );
    assert_eq!(t.desk.lists().unwrap().switch_list[0].id, id);

    let restored = t.restart();
    assert_eq!(t.desk.group().id, id, "重启后桌面上还是这个参考组");
    assert_matches(&restored, &reread(&t, &id));
    let b = restored.iter().find(|p| p.placement.rotation == 1).unwrap();
    assert_eq!(b.opacity, 0.4);
    assert!(b.locked);
}

#[test]
fn switching_away_and_back_keeps_crop_placement_opacity_and_lock() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 100);
    t.desk.edit(&a.id, |p| {
        p.move_to(333, 444);
        p.turn(Turn::RotateCounterClockwise);
        p.turn(Turn::FlipVertical);
        p.zoom(0.5, (333.0, 444.0));
        p.set_opacity(0.25);
        p.locked = true;
    });
    let before = t.desk.pins()[0].clone();
    let first = t.desk.group().id.clone();

    let switched = t.desk.new_desk(&mut t.history).unwrap();
    assert_eq!(switched.closed.len(), 1, "旧钉图一起关掉");
    assert!(switched.opened.pins.is_empty(), "空桌");
    t.pin_reference("b", 50);
    let second = t.desk.group().id.clone();

    let back = t.desk.switch_to(&first, &mut t.history).unwrap();
    assert_eq!(back.closed.len(), 1);
    let pin = &back.opened.pins[0];
    assert_eq!(pin.crop, before.crop);
    assert_eq!(pin.placement, before.placement);
    assert_eq!(pin.opacity, 0.25);
    assert!(pin.locked);
    assert_eq!((pin.width, pin.height), (before.width, before.height));

    let lists = t.desk.lists().unwrap();
    let ids: Vec<&str> = lists.switch_list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, [first.as_str(), second.as_str()], "最近用过的在前");
    assert!(lists.archived.is_empty());
}

#[test]
fn a_pinned_capture_lives_in_the_group_until_its_pin_closes() {
    let mut t = TestDesk::new();
    let c = t.pin_capture("c", 7);
    let capture = c.capture_id().unwrap().to_owned();
    assert!(t.history.entry(&capture).unwrap().pinned);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
    let member = &reread(&t, &id).members[0];
    assert!(matches!(member.source, MemberSource::Capture { .. }));
    assert_eq!(t.capture_files(&id), [format!("{}.png", member.id)]);

    // 截图历史清空后切走再切回：组内截图照样钉出。
    t.desk.new_desk(&mut t.history).unwrap();
    assert!(
        !t.history.entry(&capture).unwrap().pinned,
        "切走后不再算钉住"
    );
    let back = t.desk.switch_to(&id, &mut t.history).unwrap();
    assert!(back.opened.problems.is_empty());
    assert_eq!(
        back.opened.pins[0].capture_id(),
        Some(capture.as_str()),
        "截图历史里还有关联的条目时直接用它，不再放回一份"
    );

    let pin = back.opened.pins[0].clone();
    t.desk.close(&pin.id, &mut t.history);
    t.desk.flush().unwrap();
    assert!(t.capture_files(&id).is_empty(), "没有成员再用它时删除");
    assert!(
        !t.group_file(&id).exists(),
        "最后一个成员移出，没有名称的参考组随之消失"
    );
    assert!(t.desk.lists().unwrap().switch_list.is_empty());
}

#[test]
fn collecting_a_pinned_capture_relinks_its_member_to_the_reference_image() {
    let mut t = TestDesk::new();
    let library = Library::create(&t.root.join("library"), "资料库").unwrap();
    let c = t.pin_capture("c", 9);
    let capture = c.capture_id().unwrap().to_owned();
    let collected = t.history.collect(&capture, &library).unwrap();

    let done = t
        .desk
        .collected(&mut t.history, &capture, &collected)
        .unwrap();
    assert_eq!(done.report.relinked.len(), 1);
    assert_eq!(done.converted.len(), 1);
    assert!(matches!(
        done.converted[0].content,
        PinContent::Reference { .. }
    ));
    let id = t.desk.group().id.clone();
    let group = reread(&t, &id);
    assert_eq!(
        group.members[0].source,
        MemberSource::Library {
            library_id: collected.library_id.clone(),
            image_id: collected.image_id.clone(),
        }
    );
    assert!(t.capture_files(&id).is_empty(), "组内那份删除");
    assert_matches(t.desk.pins(), &group);
}

#[test]
fn a_blank_desk_is_never_written_and_a_named_group_stays_when_emptied() {
    let mut t = TestDesk::new();
    t.desk.flush().unwrap();
    let blank = t.desk.group().id.clone();
    assert!(!t.group_file(&blank).exists(), "空桌不落盘");
    t.desk.new_desk(&mut t.history).unwrap();
    assert!(t.groups().list().unwrap().is_empty());

    let a = t.pin_reference("a", 10);
    let id = t.desk.group().id.clone();
    t.desk.rename(&id, "头发").unwrap();
    t.desk.close(&a.id, &mut t.history);
    t.desk.flush().unwrap();
    let group = reread(&t, &id);
    assert_eq!(group.name, "头发");
    assert!(group.members.is_empty(), "有名称的留着，是空的");
}

#[test]
fn archived_groups_are_byte_identical_after_any_desk_action() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_capture("c", 1);
    let archived = t.desk.group().id.clone();
    t.desk.archive(&archived, &mut t.history).unwrap();
    let bytes = std::fs::read(t.group_file(&archived)).unwrap();
    let captures = t.capture_files(&archived);

    let b = t.pin_reference("b", 20);
    t.desk.edit(&b.id, |p| p.move_to(1, 2));
    t.pin_capture("d", 2);
    t.desk.flush().unwrap();
    let other = t.desk.group().id.clone();
    t.desk.new_desk(&mut t.history).unwrap();
    t.desk.switch_to(&other, &mut t.history).unwrap();
    t.desk.close(&b.id, &mut t.history);
    t.restart();

    assert_eq!(std::fs::read(t.group_file(&archived)).unwrap(), bytes);
    assert_eq!(t.capture_files(&archived), captures);
    let lists = t.desk.lists().unwrap();
    assert_eq!(lists.archived.len(), 1);
    assert_eq!(lists.archived[0].id, archived);
}

#[test]
fn archiving_or_discarding_the_group_on_the_desk_moves_to_another_or_a_blank_desk() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    let first = t.desk.group().id.clone();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("b", 20);
    let second = t.desk.group().id.clone();

    let switched = t.desk.archive(&second, &mut t.history).unwrap().unwrap();
    assert_eq!(t.desk.group().id, first, "换到切换列表里最近用过的另一个");
    assert_eq!(switched.opened.pins.len(), 1);

    let switched = t.desk.discard(&first, &mut t.history).unwrap().unwrap();
    assert!(switched.opened.pins.is_empty(), "没有别的了：空桌");
    assert!(t.desk.group().members.is_empty());
    let lists = t.desk.lists().unwrap();
    assert!(lists.switch_list.is_empty());
    assert_eq!(lists.on_desk, None);
    assert_eq!(lists.archived.len(), 1, "删掉的不在归档里");

    // 取出：放回切换列表并摆到桌面上，改的是原件。
    let out = t.desk.unarchive(&second, &mut t.history).unwrap();
    assert_eq!(out.opened.pins.len(), 1);
    let pin = out.opened.pins[0].clone();
    t.desk.edit(&pin.id, |p| p.move_to(77, 88));
    t.desk.flush().unwrap();
    assert_eq!(reread(&t, &second).members[0].placement.x, 77);
    assert!(t.desk.lists().unwrap().archived.is_empty());
}

#[test]
fn undoing_a_discard_brings_back_members_and_their_captures() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_capture("c", 4);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
    let captures = t.capture_files(&id);
    let bytes = std::fs::read(t.group_file(&id)).unwrap();

    t.desk.discard(&id, &mut t.history).unwrap();
    assert!(!t.group_file(&id).exists());
    let (_, switched) = t.desk.undo_discard(&id, &mut t.history).unwrap();
    let switched = switched.expect("删除时在桌面上，撤销后摆回桌面");
    assert_eq!(switched.opened.pins.len(), 2);
    assert!(switched.opened.problems.is_empty());
    assert_eq!(std::fs::read(t.group_file(&id)).unwrap(), bytes);
    assert_eq!(t.capture_files(&id), captures);
    assert_eq!(t.desk.lists().unwrap().switch_list[0].id, id);
}

#[test]
fn members_of_an_unavailable_library_survive_switching_and_syncing() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_reference("b", 20);
    let id = t.desk.group().id.clone();
    t.desk.new_desk(&mut t.history).unwrap();
    let back = t.desk.switch_to(&id, &mut t.history).unwrap();
    assert_eq!(back.opened.pins.len(), 2, "资料库不在也钉出（显示占位）");
    let pin = back.opened.pins[0].clone();
    t.desk.edit(&pin.id, |p| p.move_to(5, 5));
    t.restart();
    assert_eq!(reread(&t, &id).members.len(), 2);
}

#[test]
fn the_first_open_turns_old_pins_into_a_group_and_archives_old_groups() {
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

    let migrated = t.desk.group().clone();
    assert!(migrated.is_unnamed());
    assert_eq!(migrated.members.len(), 2);
    assert_eq!(migrated.members[0].opacity, 0.5, "透明度随成员保存");
    assert_eq!(
        std::fs::read(t.group_file(&old_group)).unwrap(),
        old_bytes,
        "旧参考组文件一个字节都不改"
    );
    let lists = t.desk.lists().unwrap();
    assert_eq!(lists.archived.len(), 1, "旧参考组都在归档里");
    assert_eq!(lists.archived[0].id, old_group);
    assert_eq!(lists.switch_list[0].id, migrated.id);

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
    let mut t = TestDesk::with(|root| {
        let mut store = kinshoko_core::desktop::PinStore::open(root).unwrap();
        store.put(reference_pin("a", 10));
        store.put(reference_pin("b", 20));
        store.save().unwrap();
    });
    let first = t.desk.group().clone();
    // 像写完参考组、还没写桌面状态时断电一样：去掉桌面状态再打开。
    std::fs::remove_file(t.root.join("desk.json")).unwrap();
    t.restart();
    let second = t.desk.group().clone();
    assert_eq!(second.id, first.id, "不产生重复的参考组");
    assert_eq!(second.members.len(), 2, "不丢钉图");
    assert_eq!(t.groups().list().unwrap().len(), 1);
}

#[test]
fn a_named_library_only_group_with_default_opacity_and_lock_keeps_format_version_one() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    t.desk.edit(&a.id, |p| p.move_to(30, 40));
    let id = t.desk.group().id.clone();
    t.desk.rename(&id, "手").unwrap();
    let text = std::fs::read_to_string(t.group_file(&id)).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["formatVersion"], 1);
    let member = &json["members"][0];
    assert!(member.get("opacity").is_none(), "{text}");
    assert!(member.get("locked").is_none(), "{text}");

    // 同样的成员由旧入口写出，字段完全相同。
    let mut pins = vec![t.desk.pins()[0].clone()];
    pins[0].member = None;
    let old = t.groups().create("手", &mut pins).unwrap();
    let old_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(t.group_file(&old.id)).unwrap()).unwrap();
    let keys = |v: &serde_json::Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(keys(&json), keys(&old_json));
    assert_eq!(keys(member), keys(&old_json["members"][0]));
    assert_eq!(member["placement"], old_json["members"][0]["placement"]);
}

#[test]
fn an_unnamed_group_is_written_with_a_newer_format_version() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
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
fn a_reference_group_package_leaves_out_opacity_and_lock() {
    let mut t = TestDesk::new();
    let c = t.pin_capture("c", 6);
    t.desk.edit(&c.id, |p| {
        p.set_opacity(0.3);
        p.locked = true;
    });
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
    let out = t.root.join("out.kinshoko-group");
    t.groups().export_package(&id, &NoLibraries, &out).unwrap();
    let manifest = kinshoko_core::reference_groups::read_package(&out).unwrap();
    let member = &manifest.group.members[0];
    assert_eq!((member.opacity, member.locked), (1.0, false));
    assert!(manifest.group.is_unnamed(), "没有名称的参考组也能导出");
    let reread = reread(&t, &id);
    assert_eq!(
        (reread.members[0].opacity, reread.members[0].locked),
        (0.3, true)
    );
}

#[test]
fn stepping_walks_the_whole_switch_list_and_wraps_around() {
    let mut t = TestDesk::new();
    let mut ids = Vec::new();
    for (i, x) in [10, 20, 30].into_iter().enumerate() {
        if i > 0 {
            t.desk.new_desk(&mut t.history).unwrap();
        }
        t.pin_reference(&format!("p{i}"), x);
        t.desk.flush().unwrap();
        ids.push(t.desk.group().id.clone());
    }
    // 切换列表：最近用过的在前 = [2, 1, 0]，桌面上是 2。
    let order: Vec<String> = t
        .desk
        .lists()
        .unwrap()
        .switch_list
        .iter()
        .map(|s| s.id.clone())
        .collect();
    assert_eq!(order, [ids[2].clone(), ids[1].clone(), ids[0].clone()]);
    let mut seen = Vec::new();
    for _ in 0..3 {
        t.desk.step(true, &mut t.history).unwrap().unwrap();
        seen.push(t.desk.group().id.clone());
    }
    assert_eq!(
        seen,
        [ids[1].clone(), ids[0].clone(), ids[2].clone()],
        "走完一圈回到原处"
    );
    t.desk.step(false, &mut t.history).unwrap().unwrap();
    assert_eq!(t.desk.group().id, ids[0], "上一个从头回到尾");

    let mut one = TestDesk::new();
    one.pin_reference("a", 1);
    one.desk.flush().unwrap();
    assert!(
        one.desk.step(true, &mut one.history).unwrap().is_none(),
        "只有一个时什么都不做"
    );
}

#[test]
fn group_shortcuts_exist_only_when_the_desk_switch_is_on() {
    use kinshoko_core::ShortcutAction;
    assert!(ShortcutAction::NextGroup.needs_desk_groups());
    assert!(!ShortcutAction::Capture.needs_desk_groups());
}

#[test]
fn flushing_says_when_the_group_list_would_look_different() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 100);
    assert!(t.desk.flush().unwrap(), "空桌钉上第一张后进了切换列表");
    t.desk.edit(&a.id, |p| p.move_to(120, 260));
    assert!(!t.desk.flush().unwrap(), "只拖动，列表上看不出");
    assert!(!t.desk.flush().unwrap(), "没有改动");
    let b = t.pin_reference("b", 900);
    assert!(t.desk.flush().unwrap(), "张数变了");
    t.desk.close(&b.id, &mut t.history);
    assert!(t.desk.flush().unwrap(), "张数变了");
    t.desk.close(&a.id, &mut t.history);
    assert!(t.desk.flush().unwrap(), "最后一张关掉后不在切换列表里");
}

/// 一个带自带截图的旧参考组（已归档），桌面换到一张空桌。返回它的 id。
fn archived_group_with_a_capture(t: &mut TestDesk) -> String {
    t.pin_reference("a", 10);
    let c = t.pin_capture("c", 1);
    t.desk.edit(&c.id, |p| p.move_to(-9000, 70));
    let source = t.desk.group().id.clone();
    t.desk.archive(&source, &mut t.history).unwrap();
    source
}

#[test]
fn merging_copies_every_member_onto_the_desk_and_leaves_the_source_alone() {
    let mut t = TestDesk::new();
    let source = archived_group_with_a_capture(&mut t);
    let bytes = std::fs::read(t.group_file(&source)).unwrap();
    t.pin_reference("own", 2000);

    let merged = t
        .desk
        .merge_in(&source, &mut t.history, &[screen()])
        .unwrap();

    assert!(
        merged.opened.problems.is_empty(),
        "{:?}",
        merged.opened.problems
    );
    assert_eq!(merged.opened.pins.len(), 2);
    assert_eq!(t.desk.pins().len(), 3);
    let on_desk = t.desk.group().id.clone();
    assert_eq!(merged.undo.group_id, on_desk);
    let from = reread(&t, &source);
    let is_capture = |m: &GroupMember| matches!(m.source, MemberSource::Capture { .. });
    for original in &from.members {
        let pin = merged
            .opened
            .pins
            .iter()
            .find(|p| p.capture_id().is_some() == is_capture(original))
            .unwrap();
        assert_eq!(pin.crop, original.crop);
        if original.placement.x >= 0 {
            assert_eq!(pin.placement, original.placement, "摆放与来源一致");
        } else {
            assert!(pin.placement.x >= 0, "屏幕外的拉回屏幕");
        }
    }
    t.desk.flush().unwrap();
    assert_matches(t.desk.pins(), &reread(&t, &on_desk));
    assert_eq!(
        std::fs::read(t.group_file(&source)).unwrap(),
        bytes,
        "来源参考组的文件字节不变"
    );
    assert_eq!(t.capture_files(&source).len(), 1);
    assert_eq!(t.capture_files(&on_desk).len(), 1, "自带截图复制一份");
}

#[test]
fn the_merged_capture_is_a_separate_file_from_the_source() {
    let mut t = TestDesk::new();
    let source = archived_group_with_a_capture(&mut t);
    let merged = t
        .desk
        .merge_in(&source, &mut t.history, &[screen()])
        .unwrap();
    let on_desk = merged.undo.group_id.clone();
    let capture = merged
        .opened
        .pins
        .iter()
        .find(|p| p.capture_id().is_some())
        .unwrap();

    t.desk.close(&capture.id, &mut t.history);
    t.desk.flush().unwrap();
    assert!(t.capture_files(&on_desk).is_empty(), "桌面上的那份删了");
    assert_eq!(t.capture_files(&source).len(), 1, "来源的那份还在");
    let opened = t.desk.switch_to(&source, &mut t.history).unwrap().opened;
    assert!(opened.problems.is_empty(), "{:?}", opened.problems);
    assert_eq!(opened.pins.len(), 2);
}

#[test]
fn undoing_a_merge_takes_the_desk_back_and_deletes_the_copied_captures() {
    let mut t = TestDesk::new();
    let source = archived_group_with_a_capture(&mut t);
    let own = t.pin_reference("own", 2000);
    t.desk.flush().unwrap();
    let on_desk = t.desk.group().id.clone();

    let merged = t
        .desk
        .merge_in(&source, &mut t.history, &[screen()])
        .unwrap();
    t.desk.undo_merge(&merged.undo, &mut t.history).unwrap();

    assert_eq!(
        t.desk.pins().iter().map(|p| &p.id).collect::<Vec<_>>(),
        vec![&own.id]
    );
    let group = reread(&t, &on_desk);
    assert_eq!(group.members.len(), 1);
    assert!(t.capture_files(&on_desk).is_empty(), "复制来的截图删除");
    assert_eq!(t.capture_files(&source).len(), 1);
}

#[test]
fn undoing_a_merge_after_switching_away_edits_that_groups_file() {
    let mut t = TestDesk::new();
    let source = archived_group_with_a_capture(&mut t);
    t.pin_reference("own", 2000);
    let merged = t
        .desk
        .merge_in(&source, &mut t.history, &[screen()])
        .unwrap();
    t.desk.new_desk(&mut t.history).unwrap();

    t.desk.undo_merge(&merged.undo, &mut t.history).unwrap();

    assert_eq!(reread(&t, &merged.undo.group_id).members.len(), 1);
    assert!(t.capture_files(&merged.undo.group_id).is_empty());
}

#[test]
fn undoing_a_merge_into_an_empty_desk_after_switching_away_leaves_no_empty_group() {
    let mut t = TestDesk::new();
    t.pin_reference("other", 10);
    t.desk.flush().unwrap();
    let other = t.desk.group().id.clone();
    let source = archived_group_with_a_capture(&mut t);
    t.desk.new_desk(&mut t.history).unwrap();
    let merged = t
        .desk
        .merge_in(&source, &mut t.history, &[screen()])
        .unwrap();
    t.desk.switch_to(&other, &mut t.history).unwrap();

    t.desk.undo_merge(&merged.undo, &mut t.history).unwrap();

    assert!(
        !t.group_file(&merged.undo.group_id).exists(),
        "空参考组连文件一起消失"
    );
    let lists = t.desk.lists().unwrap();
    let ids: Vec<&str> = lists.switch_list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, [other.as_str()], "切换列表里不留空的那一项");
    t.restart();
    let ids: Vec<String> = t
        .desk
        .lists()
        .unwrap()
        .switch_list
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, [other], "桌面状态也写了");
}

#[test]
fn moving_a_pin_takes_it_off_the_desk_into_the_other_group_with_its_capture() {
    let mut t = TestDesk::new();
    t.pin_reference("x", 10);
    t.desk.flush().unwrap();
    let target = t.desk.group().id.clone();
    t.desk.new_desk(&mut t.history).unwrap();
    let keep = t.pin_reference("keep", 30);
    let c = t.pin_capture("c", 4);
    t.desk.edit(&c.id, |p| p.move_to(700, 300));
    let placed = t.desk.get(&c.id).unwrap().placement;
    let on_desk = t.desk.group().id.clone();

    let moved = t.desk.move_pin(&c.id, &target, &mut t.history).unwrap();

    assert_eq!(moved.map(|p| p.id), Some(c.id.clone()));
    assert_eq!(
        t.desk.pins().iter().map(|p| &p.id).collect::<Vec<_>>(),
        vec![&keep.id]
    );
    assert_eq!(reread(&t, &on_desk).members.len(), 1);
    assert!(t.capture_files(&on_desk).is_empty(), "原参考组里没有");
    assert_eq!(t.capture_files(&target).len(), 1, "文件在目标参考组里");
    let opened = t.desk.switch_to(&target, &mut t.history).unwrap().opened;
    assert!(opened.problems.is_empty(), "{:?}", opened.problems);
    assert_eq!(opened.pins.len(), 2);
    let shown = opened
        .pins
        .iter()
        .find(|p| p.capture_id().is_some())
        .unwrap();
    assert_eq!(shown.placement, placed, "摆放不变");
}

#[test]
fn moving_to_the_group_on_the_desk_does_nothing() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let here = t.desk.group().id.clone();
    assert_eq!(t.desk.move_pin(&a.id, &here, &mut t.history).unwrap(), None);
    assert_eq!(t.desk.pins().len(), 1);
}

#[test]
fn removing_a_member_when_the_desk_state_cannot_be_saved_keeps_it_and_its_pin() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    let c = t.pin_capture("c", 2);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
    let member = c.member.clone().unwrap().member_id;
    let pins = t.desk.pins().to_vec();

    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    assert!(t.desk.remove_member(&id, &member, &mut t.history).is_err());
    assert_eq!(t.desk.pins(), &pins[..], "钉图还在");
    assert_eq!(t.desk.group().members.len(), 2, "成员还在");

    std::fs::remove_dir_all(&state).unwrap();
    t.desk.edit(&pins[0].id, |p| p.move_to(30, 30));
    t.desk.flush().unwrap();
    assert_eq!(reread(&t, &id).members.len(), 2, "之后落盘不会把移出写进去");
    assert_eq!(t.capture_files(&id).len(), 1, "组内截图也放回来");
    let opened = t.restart();
    assert_eq!(opened.len(), 2, "重新启动后两张都钉得出来");
}

#[test]
fn removing_a_member_of_the_group_on_the_desk_closes_its_pin_and_is_kept() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let b = t.pin_reference("b", 20);
    let id = t.desk.group().id.clone();
    let member = b.member.clone().unwrap().member_id;

    let group = t
        .desk
        .remove_member(&id, &member, &mut t.history)
        .unwrap()
        .unwrap();

    assert_eq!(group.members.len(), 1);
    assert_eq!(
        t.desk.pins().iter().map(|p| &p.id).collect::<Vec<_>>(),
        vec![&a.id]
    );
    t.desk.flush().unwrap();
    let file = reread(&t, &id);
    assert_eq!(file.members.len(), 1, "下次落盘不会把它写回去");
    assert_eq!(
        file.updated_at,
        t.desk.lists().unwrap().switch_list[0].updated_at
    );
    assert_eq!(
        t.desk.remove_member("other", "x", &mut t.history).unwrap(),
        None
    );
}

#[test]
fn the_lists_follow_the_desk_before_it_is_saved() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let id = t.desk.group().id.clone();
    let lists = t.desk.lists().unwrap();
    assert_eq!(lists.on_desk.as_deref(), Some(id.as_str()));
    assert_eq!(lists.switch_list.len(), 1, "钉上第一张就在切换列表里");
    assert_eq!(lists.switch_list[0].id, id);

    t.desk.flush().unwrap();
    t.desk.close(&a.id, &mut t.history);
    let lists = t.desk.lists().unwrap();
    assert!(lists.on_desk.is_none());
    assert!(
        lists.switch_list.is_empty(),
        "关掉最后一张，没有名称的不再列出"
    );
    assert!(lists.archived.is_empty());
}

#[test]
fn a_switch_that_cannot_save_the_desk_state_changes_nothing() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let a = t.desk.group().id.clone();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("b", 20);
    t.desk.flush().unwrap();
    let b = t.desk.group().id.clone();
    let pins = t.desk.pins().to_vec();

    // 桌面状态写不进：desk.json 换成一个非空目录。
    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    assert!(t.desk.switch_to(&a, &mut t.history).is_err());
    assert_eq!(t.desk.group().id, b, "桌面还是原来那一桌");
    assert_eq!(t.desk.pins(), &pins[..]);
    let order: Vec<String> = t
        .desk
        .lists()
        .unwrap()
        .switch_list
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(order, [b.clone(), a.clone()], "切换列表也不变");

    std::fs::remove_dir_all(&state).unwrap();
    let switched = t.desk.switch_to(&a, &mut t.history).unwrap();
    assert_eq!(switched.closed.len(), 1);
    assert_eq!(t.desk.group().id, a);
}

#[test]
fn editing_pins_between_steps_still_reaches_every_group() {
    let mut t = TestDesk::new();
    let mut ids = Vec::new();
    for (i, x) in [10, 20, 30].into_iter().enumerate() {
        if i > 0 {
            t.desk.new_desk(&mut t.history).unwrap();
        }
        t.pin_reference(&format!("p{i}"), x);
        t.desk.flush().unwrap();
        ids.push(t.desk.group().id.clone());
    }
    // [2, 1, 0]：每到一桌就挪一张钉图再落盘，顺序不变，照样走完一圈。
    let mut seen = Vec::new();
    for _ in 0..3 {
        t.desk.step(true, &mut t.history).unwrap().unwrap();
        let pin = t.desk.pins()[0].id.clone();
        t.desk.edit(&pin, |p| p.move_to(50, 50));
        t.desk.flush().unwrap();
        seen.push(t.desk.group().id.clone());
    }
    assert_eq!(seen, [ids[1].clone(), ids[0].clone(), ids[2].clone()]);
}

#[test]
fn deleting_the_group_on_the_desk_when_the_desk_state_cannot_be_saved_keeps_it() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_capture("c", 3);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
    let captures = t.capture_files(&id);

    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    assert!(t.desk.discard(&id, &mut t.history).is_err());
    assert_eq!(t.desk.group().id, id);
    assert!(t.group_file(&id).exists(), "文件放回原处");
    assert_eq!(t.capture_files(&id), captures, "组内截图也放回");

    std::fs::remove_dir_all(&state).unwrap();
    let switched = t.desk.discard(&id, &mut t.history).unwrap();
    assert!(switched.is_some(), "之后照常能删");
}

#[test]
fn a_merged_capture_member_shares_the_source_capture_history_entry() {
    let mut t = TestDesk::new();
    let source = archived_group_with_a_capture(&mut t);
    let entries = t.history.entries().len();

    let merged = t
        .desk
        .merge_in(&source, &mut t.history, &[screen()])
        .unwrap();

    assert_eq!(t.history.entries().len(), entries, "不另建截图历史");
    let capture = merged
        .opened
        .pins
        .iter()
        .find_map(|p| p.capture_id())
        .unwrap();
    let linked = t.history.linked_members(capture);
    assert!(linked.iter().any(|m| m.group_id == source), "{linked:?}");
    assert!(
        linked.iter().any(|m| m.group_id == t.desk.group().id),
        "副本也关联这条截图，收藏时一起改连：{linked:?}"
    );
}

#[test]
fn deleting_another_group_when_the_desk_state_cannot_be_saved_keeps_it() {
    let mut t = TestDesk::new();
    t.pin_capture("c", 3);
    t.desk.flush().unwrap();
    let other = t.desk.group().id.clone();
    let captures = t.capture_files(&other);
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();

    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    assert!(t.desk.discard(&other, &mut t.history).is_err());
    assert!(t.group_file(&other).exists(), "文件放回原处");
    assert_eq!(t.capture_files(&other), captures);
    let listed = |t: &TestDesk| {
        t.desk
            .lists()
            .unwrap()
            .switch_list
            .iter()
            .any(|s| s.id == other)
    };
    assert!(listed(&t), "还在切换列表里");

    std::fs::remove_dir_all(&state).unwrap();
    assert!(t.desk.discard(&other, &mut t.history).unwrap().is_none());
    assert!(!listed(&t));
}

#[test]
fn archiving_the_group_on_the_desk_when_the_desk_state_cannot_be_saved_keeps_it_listed() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();

    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    assert!(t.desk.archive(&id, &mut t.history).is_err());
    std::fs::remove_dir_all(&state).unwrap();

    // 之后什么都没改就换到空桌：它照样留在切换列表里。
    t.desk.new_desk(&mut t.history).unwrap();
    t.restart();
    let ids: Vec<String> = t
        .desk
        .lists()
        .unwrap()
        .switch_list
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, [id]);
}

#[test]
fn undoing_a_delete_that_cannot_switch_back_can_be_retried() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let id = t.desk.group().id.clone();
    t.desk.discard(&id, &mut t.history).unwrap();

    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    assert!(t.desk.undo_discard(&id, &mut t.history).is_err());
    std::fs::remove_dir_all(&state).unwrap();

    let (_, switched) = t.desk.undo_discard(&id, &mut t.history).unwrap();
    assert!(switched.is_some(), "再撤销一次就摆回桌面");
    assert_eq!(t.desk.group().id, id);
    assert_eq!(t.desk.pins().len(), 1);
}
