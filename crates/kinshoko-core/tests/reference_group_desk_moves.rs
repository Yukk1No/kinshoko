//! 桌面上的参考组（#588、#590）：在参考组之间挪成员（加进上一组、移到新参考组、移出一个成员）与写不进时的复原。
//! 经 `kinshoko_core` 的对外接口，用临时目录里的真文件。

#[path = "support/desk.rs"]
mod desk;
#[path = "support/group_fixture.rs"]
mod group_fixture;

use desk::{TestDesk, capture_pin, reference_pin, shot};
use group_fixture::GroupFixture;
use kinshoko_core::desktop::SavedPin;
use kinshoko_core::reference_groups::{GroupMember, ReferenceGroup};

const DAY: i64 = 24 * 60 * 60 * 1000;

fn reread(t: &TestDesk, id: &str) -> ReferenceGroup {
    t.groups().get(id).unwrap()
}

/// 不变量 2：钉图与钉着的成员一一对应，摆放相同。
fn assert_matches(pins: &[SavedPin], group: &ReferenceGroup) {
    let pinned: Vec<&GroupMember> = group.members.iter().filter(|m| m.pinned).collect();
    assert_eq!(pins.len(), pinned.len(), "钉图与钉着的成员一样多");
    for pin in pins {
        let member = pin.member.as_ref().expect("钉图记着成员");
        assert_eq!(member.group_id, group.id);
        let m = pinned
            .iter()
            .find(|m| m.id == member.member_id)
            .expect("成员在参考组里，钉着");
        assert_eq!(m.crop, pin.crop);
        assert_eq!(m.placement, pin.placement);
        assert_eq!(m.opacity, pin.opacity);
        assert_eq!(m.locked, pin.locked);
    }
}

fn ids(list: &[kinshoko_core::reference_groups::GroupSummary]) -> Vec<String> {
    list.iter().map(|s| s.id.clone()).collect()
}

/// 桌面状态写不进：desk.json 换成一个非空目录。返回恢复用的路径。
fn break_state(t: &TestDesk) -> std::path::PathBuf {
    let state = t.root.join("desk.json");
    let _ = std::fs::remove_file(&state);
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    state
}

#[test]
fn folding_into_the_previous_group_moves_members_and_captures_and_puts_it_on_the_desk() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let previous = t.desk_id();
    let a = t.desk.pins()[0].id.clone();
    t.desk.close(&a, &mut t.history);
    t.desk.new_desk(&mut t.history).unwrap();

    let pinned = t
        .desk
        .pin(
            capture_pin("c", &t.history.add(&shot(5)).unwrap().id),
            &mut t.history,
        )
        .unwrap();
    let fresh = t.desk_id();
    let capture = pinned.pin.capture_id().unwrap().to_owned();
    t.pin_reference("b", 30);
    t.desk.flush().unwrap();
    assert_eq!(t.capture_files(&fresh).len(), 1);

    let switched = t
        .desk
        .fold_into_previous(pinned.fold_into.as_deref().unwrap(), &mut t.history)
        .unwrap();
    assert_eq!(t.desk_id(), previous, "上一组摆上桌面");
    assert!(!t.group_file(&fresh).exists(), "新参考组删掉");
    assert!(t.capture_files(&fresh).is_empty());
    assert_eq!(switched.closed.len(), 2);
    assert_eq!(
        switched.opened.pins.len(),
        2,
        "移来的两张钉着；原来那张没钉着"
    );
    let group = reread(&t, &previous);
    assert_eq!(group.members.len(), 3);
    assert_eq!(t.capture_files(&previous).len(), 1, "截图跟着移过去");
    assert_matches(t.desk.pins(), &group);
    let linked = t.history.linked_members(&capture);
    assert!(
        linked.iter().any(|m| m.group_id == previous),
        "截图历史改连到上一组，之后收藏仍能改连：{linked:?}"
    );
    assert!(!ids(&t.desk.lists().unwrap().recent).contains(&fresh));
}

#[test]
fn splitting_off_a_day_moves_it_to_a_new_group_and_undo_moves_it_back() {
    // 旧参考组（成员没有添加日期，按参考组的新建时间算）摆上桌面，再钉两张新的。
    let mut old = String::new();
    let mut t = TestDesk::with(|root| {
        let groups = desk::groups(root);
        let mut pins = vec![reference_pin("old", 10)];
        old = groups.save_group("旧", &mut pins).unwrap().id;
        // 像 #588 之前存的参考组一样：成员没有添加日期。
        let file = root.join(format!("reference-groups/{old}.json"));
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        for member in json["members"].as_array_mut().unwrap() {
            member.as_object_mut().unwrap().remove("addedAt");
        }
        std::fs::write(&file, serde_json::to_vec(&json).unwrap()).unwrap();
    });
    t.desk.switch_to(&old, &mut t.history).unwrap();
    let created = reread(&t, &old).created_at;
    let today = t.pin_reference("n1", 40);
    t.pin_capture("n2", 8);
    t.desk.flush().unwrap();
    let added = reread(&t, &old)
        .members
        .iter()
        .filter_map(|m| m.added_at)
        .min()
        .unwrap();
    assert!(added >= created);

    // 这一段就是全部成员时什么都不做。
    assert!(
        t.desk
            .split_off(i64::MIN..i64::MAX, &mut t.history)
            .unwrap()
            .is_none()
    );
    let split = t
        .desk
        .split_off(added..added + DAY, &mut t.history)
        .unwrap()
        .expect("拆出两张");
    assert_eq!(split.from, old);
    assert_eq!(split.closed.len(), 2, "移走的钉图关掉");
    assert!(split.closed.iter().any(|p| p.id == today.id));
    assert_eq!(t.desk_id(), old, "桌面上的参考组不换");
    assert_eq!(reread(&t, &old).members.len(), 1);
    let new = reread(&t, &split.to);
    assert!(new.is_unnamed());
    assert_eq!(new.members.len(), 2);
    assert!(new.members.iter().all(|m| m.pinned && m.added_at.is_some()));
    assert_eq!(t.capture_files(&split.to).len(), 1);
    assert!(t.capture_files(&old).is_empty());
    assert_matches(t.desk.pins(), &reread(&t, &old));
    assert_eq!(
        ids(&t.desk.lists().unwrap().recent)[0],
        split.to,
        "新建的在前"
    );

    let undone = t.desk.undo_split(&split, &mut t.history).unwrap();
    assert_eq!(undone.opened.pins.len(), 2, "移回的钉着的成员钉出来");
    assert!(!t.group_file(&split.to).exists());
    let back = reread(&t, &old);
    assert_eq!(back.members.len(), 3);
    assert_eq!(t.capture_files(&old).len(), 1);
    assert_matches(t.desk.pins(), &back);
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
fn removing_a_member_of_the_group_on_the_desk_closes_its_pin_and_can_be_undone() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let b = t.pin_reference("b", 20);
    let id = t.desk_id();
    let member = b.member.clone().unwrap().member_id;

    let removed = t
        .desk
        .remove_member(&member, &mut t.history)
        .unwrap()
        .expect("在桌面上的参考组里");

    assert_eq!(removed.count(), 1);
    assert_eq!(
        t.desk.pins().iter().map(|p| &p.id).collect::<Vec<_>>(),
        vec![&a.id]
    );
    t.desk.flush().unwrap();
    assert_eq!(reread(&t, &id).members.len(), 1, "下次落盘不会把它写回去");
    assert_eq!(t.desk.remove_member("x", &mut t.history).unwrap(), None);

    t.desk.undo_prune(&removed).unwrap();
    let group = reread(&t, &id);
    assert_eq!(group.members.len(), 2);
    assert!(!group.members[1].pinned, "放回时是没钉着的");
    assert_eq!(t.desk.pins().len(), 1);
}

#[test]
fn removing_the_last_pinned_member_leaves_the_desk_empty() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let id = t.desk_id();
    let member = a.member.clone().unwrap().member_id;

    t.desk
        .remove_member(&member, &mut t.history)
        .unwrap()
        .unwrap();

    assert!(t.desk.pins().is_empty());
    assert!(t.desk.group().is_none(), "没有钉图，桌面空着");
    assert!(t.groups().get(&id).is_err(), "空的且没有名称：文件随之删掉");
}

#[test]
fn two_failed_removals_in_a_row_keep_both_captures() {
    let mut t = TestDesk::new();
    let a = t.pin_capture("a", 2);
    let b = t.pin_capture("b", 3);
    t.desk.flush().unwrap();
    let id = t.desk_id();

    let state = t.root.join("desk.json");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    std::fs::write(state.join("x"), b"x").unwrap();
    for pin in [&a, &b] {
        let member = pin.member.clone().unwrap().member_id;
        assert!(t.desk.remove_member(&member, &mut t.history).is_err());
    }
    std::fs::remove_dir_all(&state).unwrap();

    t.desk.flush().unwrap();
    assert_eq!(t.capture_files(&id).len(), 2, "两张组内截图都在");
    assert_eq!(t.restart().len(), 2);
}

#[test]
fn duplicating_copies_members_and_captures_and_leaves_the_original_alone() {
    let mut t = TestDesk::new();
    t.pin_capture("a", 2);
    t.pin_reference("b", 20);
    let id = t.desk_id();

    let copy = t.desk.duplicate(&id, "头发 副本").unwrap();

    assert_ne!(copy.id, id);
    assert_eq!(copy.name, "头发 副本");
    let original = reread(&t, &id);
    assert_eq!(reread(&t, &copy.id).members.len(), original.members.len());
    assert_eq!(
        t.capture_files(&copy.id),
        t.capture_files(&id),
        "自带截图也复制了"
    );
    assert_eq!(t.desk_id(), id, "桌面上还是原来那组");
    let lists = t.desk.lists().unwrap();
    assert!(
        lists.favorites.iter().all(|g| g.id != copy.id),
        "复制出来的不是常用"
    );
    assert!(
        lists.recent.iter().any(|g| g.id == copy.id),
        "复制出来的进最近"
    );
}

#[test]
fn adding_from_the_wall_to_another_group_adds_an_unpinned_member_and_leaves_the_desk() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    let other = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("b", 20);
    let on_desk = t.desk_id();

    let added = t
        .desk
        .add_member(&other, &reference_pin("c", 30))
        .unwrap()
        .expect("不在桌面上的组多一个成员");
    let member = added.members.last().unwrap();
    assert!(!member.pinned, "加进别的组时不钉出来，切过去也不钉");
    assert!(member.added_at.is_some(), "记下添加日期：成员区按它分段");
    assert_eq!(reread(&t, &other).members.len(), 2);
    assert_eq!(t.desk_id(), on_desk);
    assert_eq!(t.desk.pins().len(), 1, "桌面不变");

    assert!(
        t.desk
            .add_member(&on_desk, &reference_pin("d", 40))
            .unwrap()
            .is_none(),
        "加进桌面上那组：调用方把它钉出来"
    );
}
