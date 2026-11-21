//! 桌面上的参考组（#588、#590）：桌面上至多摆着一个参考组，钉图是它钉着的成员，改动直接记下；
//! 关掉钉图只标成没钉着；钉回、移出没钉着的、加进上一组、按天移到新参考组、常用、删除与撤销；
//! 第一次打开时从 `pins.json` 迁移。经 `kinshoko_core` 的对外接口，用临时目录里的真文件。
//! 资料库 `lib` 不存在：资料库成员一直是“资料库不可用”，照样要留着。
//!
//! 模块说明里的四条不变量各有一个 `invariant_*` 测试。

#[path = "support/desk.rs"]
mod desk;

use desk::{TestDesk, assert_matches, capture_pin, ids, reference_pin, reread, shot};
use kinshoko_core::Library;
use kinshoko_core::desktop::{PinContent, Turn};
use kinshoko_core::reference_groups::{MemberSource, OLDER_AFTER_MS};

const DAY: i64 = 24 * 60 * 60 * 1000;

#[test]
fn invariant_1_the_desk_holds_at_most_one_group_and_none_when_empty() {
    let mut t = TestDesk::new();
    assert!(t.desk.group().is_none(), "一开始桌面空着");
    t.desk.flush().unwrap();
    assert!(t.groups().list().unwrap().is_empty(), "空桌不落盘");

    let first = t.desk.pin(reference_pin("a", 10), &mut t.history).unwrap();
    assert_eq!(first.fold_into, None, "没有上一组，不提示加进");
    let a = t.desk_id();
    t.pin_reference("b", 20);
    assert_eq!(t.desk_id(), a, "桌面上有钉图时新钉的加进那组");

    let pins: Vec<String> = t.desk.pins().iter().map(|p| p.id.clone()).collect();
    t.desk.close(&pins[0], &mut t.history);
    assert_eq!(t.desk.group().map(|g| g.id.clone()), Some(a.clone()));
    t.desk.close(&pins[1], &mut t.history);
    assert_eq!(
        t.desk.group().map(|g| g.id.clone()),
        Some(a.clone()),
        "关掉最后一张，参考组仍在桌面上（#588 11-19 晚）"
    );
    assert_eq!(t.desk.lists().unwrap().on_desk.as_deref(), Some(a.as_str()));
    t.desk.flush().unwrap();
    assert_eq!(reread(&t, &a).members.len(), 2, "成员都留着");
    t.pin_reference("c0", 25);
    assert_eq!(t.desk_id(), a, "关掉最后一张后再钉，还加进这组");

    t.desk.new_desk(&mut t.history).unwrap();
    assert!(t.desk.group().is_none(), "只有新参考组之后桌面才空着");
    let next = t.desk.pin(reference_pin("c", 30), &mut t.history).unwrap();
    let b = t.desk_id();
    assert_ne!(b, a, "空桌钉下的第一张开新参考组");
    assert_eq!(
        next.fold_into.as_deref(),
        Some(a.as_str()),
        "提示里可加进上一组"
    );
    assert_eq!(t.desk.previous().as_deref(), Some(a.as_str()));

    let cleared = t.desk.new_desk(&mut t.history).unwrap();
    assert_eq!(cleared.closed.len(), 1, "新建就是清空桌面");
    assert!(t.desk.group().is_none());
    assert!(reread(&t, &b).members[0].pinned, "清空桌面不改钉着");
    assert_eq!(t.restart().len(), 0, "重启后桌面还空着");
    assert!(t.desk.group().is_none());
}

#[test]
fn invariant_2_pins_match_the_pinned_members_through_edits_closes_and_restarts() {
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

    let id = t.desk_id();
    let group = reread(&t, &id);
    assert!(group.is_unnamed(), "不用起名");
    assert_eq!(group.members.len(), 3, "关掉的那张还是成员");
    assert_eq!(
        group.members.iter().filter(|m| !m.pinned).count(),
        1,
        "标成没钉着"
    );
    assert_matches(t.desk.pins(), &group);
    assert!(group.members.iter().all(|m| m.added_at.is_some()));

    let restored = t.restart();
    assert_eq!(t.desk_id(), id, "重启后桌面上还是这个参考组");
    assert_eq!(restored.len(), 2, "没钉着的不钉出");
    assert_matches(&restored, &reread(&t, &id));
    let b = restored.iter().find(|p| p.placement.rotation == 1).unwrap();
    assert_eq!(b.opacity, 0.4);
    assert!(b.locked);

    // 钉回：回到原来的位置，又是钉着的。
    let unpinned = reread(&t, &id)
        .members
        .into_iter()
        .find(|m| !m.pinned)
        .unwrap();
    let back = t
        .desk
        .repin(&unpinned.id, &mut t.history)
        .unwrap()
        .expect("钉回");
    assert_eq!(back.placement, unpinned.placement);
    assert!(
        t.desk
            .repin(&unpinned.id, &mut t.history)
            .unwrap()
            .is_none(),
        "钉着的不再钉一次"
    );
    t.desk.flush().unwrap();
    assert_matches(t.desk.pins(), &reread(&t, &id));
    assert_eq!(t.desk.pins().len(), 3);
}

#[test]
fn invariant_3_a_capture_file_exists_while_any_member_uses_it() {
    let mut t = TestDesk::new();
    let keep = t.pin_reference("a", 10);
    let c = t.pin_capture("c", 7);
    let capture = c.capture_id().unwrap().to_owned();
    assert!(t.history.entry(&capture).unwrap().pinned);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    let member = reread(&t, &id)
        .members
        .into_iter()
        .find(|m| matches!(m.source, MemberSource::Capture { .. }))
        .unwrap();
    let file = format!("{}.png", member.id);
    assert_eq!(
        t.capture_files(&id),
        std::slice::from_ref(&file),
        "钉上即有组内文件"
    );

    t.desk.close(&c.id, &mut t.history);
    t.desk.flush().unwrap();
    assert!(
        !t.history.entry(&capture).unwrap().pinned,
        "关掉后不再算钉住"
    );
    assert_eq!(
        t.capture_files(&id),
        std::slice::from_ref(&file),
        "没钉着也算在用"
    );

    // 切走再切回：组内截图照样在，钉回时直接用截图历史里关联的那条。
    t.desk.new_desk(&mut t.history).unwrap();
    t.desk.switch_to(&id, &mut t.history).unwrap();
    let back = t.desk.repin(&member.id, &mut t.history).unwrap().unwrap();
    assert_eq!(back.capture_id(), Some(capture.as_str()));
    t.desk.close(&back.id, &mut t.history);

    // 移出没钉着的：文件随之删除；撤销后成员与文件都回来。
    let pruned = t.desk.prune_unpinned().unwrap().expect("有没钉着的");
    assert_eq!(pruned.count(), 1);
    assert!(t.capture_files(&id).is_empty(), "没有成员再用它时删除");
    assert_eq!(reread(&t, &id).members.len(), 1);
    t.desk.undo_prune(&pruned).unwrap();
    assert_eq!(t.capture_files(&id), [file]);
    let group = reread(&t, &id);
    assert_eq!(group.members.len(), 2);
    assert!(
        !group
            .members
            .iter()
            .find(|m| m.id == member.id)
            .unwrap()
            .pinned
    );
    assert_eq!(t.desk.pins().len(), 1, "钉着的那张一直在");
    assert_eq!(t.desk.pins()[0].placement, keep.placement);
}

#[test]
fn invariant_4_desk_actions_write_only_the_group_on_the_desk() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_capture("c", 1);
    t.desk.flush().unwrap();
    let other = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    let bytes = std::fs::read(t.group_file(&other)).unwrap();
    let captures = t.capture_files(&other);

    let b = t.pin_reference("b", 20);
    t.desk.edit(&b.id, |p| p.move_to(1, 2));
    t.pin_capture("d", 2);
    t.desk.flush().unwrap();
    let desk = t.desk_id();
    t.desk.close(&b.id, &mut t.history);
    t.desk.prune_unpinned().unwrap();
    t.desk.rename(&desk, "手").unwrap();
    t.desk.set_favorite(&desk, true).unwrap();
    t.desk.new_desk(&mut t.history).unwrap();
    t.desk.switch_to(&desk, &mut t.history).unwrap();
    // 切到 other 再切走、什么都没改：文件也不重写。
    t.desk.switch_to(&other, &mut t.history).unwrap();
    t.desk.switch_to(&desk, &mut t.history).unwrap();
    t.restart();

    assert_eq!(std::fs::read(t.group_file(&other)).unwrap(), bytes);
    assert_eq!(t.capture_files(&other), captures);
}

#[test]
fn invariant_4_folding_and_splitting_write_only_the_two_groups_involved() {
    let mut t = TestDesk::new();
    t.pin_reference("x", 10);
    t.desk.flush().unwrap();
    let bystander = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    let bytes = std::fs::read(t.group_file(&bystander)).unwrap();

    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let previous = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    let pinned = t.desk.pin(reference_pin("b", 20), &mut t.history).unwrap();
    assert_eq!(pinned.fold_into.as_deref(), Some(previous.as_str()));
    let fresh = t.desk_id();
    t.desk
        .fold_into_previous(&fresh, &previous, &mut t.history)
        .unwrap();
    let day = reread(&t, &previous).created_at;
    t.desk.split_off(day..day + 1, &mut t.history).unwrap();
    t.desk.flush().unwrap();

    assert_eq!(std::fs::read(t.group_file(&bystander)).unwrap(), bytes);
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
        .fold_into_previous(&fresh, pinned.fold_into.as_deref().unwrap(), &mut t.history)
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
        old = groups.create("旧", &mut pins).unwrap().id;
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
    let first = t.desk_id();

    let switched = t.desk.new_desk(&mut t.history).unwrap();
    assert_eq!(switched.closed.len(), 1, "旧钉图一起关掉");
    t.pin_reference("b", 50);

    let back = t.desk.switch_to(&first, &mut t.history).unwrap();
    assert_eq!(back.closed.len(), 1);
    let pin = &back.opened.pins[0];
    assert_eq!(pin.crop, before.crop);
    assert_eq!(pin.placement, before.placement);
    assert_eq!(pin.opacity, 0.25);
    assert!(pin.locked);
    assert_eq!((pin.width, pin.height), (before.width, before.height));
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
    let id = t.desk_id();
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
fn a_named_group_stays_when_emptied_and_an_unnamed_one_disappears() {
    let mut t = TestDesk::new();
    let a = t.pin_reference("a", 10);
    let named = t.desk_id();
    t.desk.rename(&named, "头发").unwrap();
    t.desk.close(&a.id, &mut t.history);
    t.desk.switch_to(&named, &mut t.history).unwrap();
    t.desk.prune_unpinned().unwrap();
    let group = reread(&t, &named);
    assert_eq!(group.name, "头发");
    assert!(group.members.is_empty(), "有名称的留着，是空的");

    t.desk.new_desk(&mut t.history).unwrap();
    let b = t.pin_reference("b", 10);
    let unnamed = t.desk_id();
    t.desk.close(&b.id, &mut t.history);
    t.desk.switch_to(&unnamed, &mut t.history).unwrap();
    t.desk.prune_unpinned().unwrap();
    assert!(
        !t.group_file(&unnamed).exists(),
        "没有名称的空参考组随之消失"
    );
    assert!(t.desk.group().is_none());
}

#[test]
fn favorites_recent_and_older_follow_use_and_creation() {
    let mut t = TestDesk::new();
    let mut made = Vec::new();
    for x in 0..3 {
        t.pin_reference("a", x);
        t.desk.flush().unwrap();
        made.push(t.desk_id());
        t.desk.new_desk(&mut t.history).unwrap();
    }
    let lists = t.desk.lists().unwrap();
    assert!(lists.favorites.is_empty(), "不自动设常用");
    let mut newest_first = made.clone();
    newest_first.reverse();
    assert_eq!(ids(&lists.recent), newest_first, "最近按新建时间排");

    t.desk.set_favorite(&made[2], true).unwrap();
    t.desk.set_favorite(&made[0], true).unwrap();
    t.desk.switch_to(&made[1], &mut t.history).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let later = now + OLDER_AFTER_MS + DAY;
    let lists = t.desk.lists_at(later).unwrap();
    assert_eq!(
        ids(&lists.favorites),
        [made[2].clone(), made[0].clone()],
        "按设的先后"
    );
    assert_eq!(
        ids(&lists.recent),
        [made[1].clone()],
        "桌面上的那个不算更早"
    );
    assert!(lists.older.is_empty());

    t.desk.new_desk(&mut t.history).unwrap();
    t.desk.set_favorite(&made[2], false).unwrap();
    let lists = t.desk.lists_at(later).unwrap();
    assert_eq!(ids(&lists.favorites), [made[0].clone()]);
    assert_eq!(
        ids(&lists.older),
        [made[2].clone(), made[1].clone()],
        "一个月没用折进更早"
    );
    t.restart();
    assert_eq!(
        ids(&t.desk.lists_at(later).unwrap().favorites),
        [made[0].clone()]
    );
}

#[test]
fn deleting_the_group_on_the_desk_leaves_the_desk_empty_and_undo_brings_it_back() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.pin_capture("c", 4);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    t.desk.set_favorite(&id, true).unwrap();
    let captures = t.capture_files(&id);
    let bytes = std::fs::read(t.group_file(&id)).unwrap();

    let switched = t.desk.discard(&id, &mut t.history).unwrap().unwrap();
    assert_eq!(switched.closed.len(), 2);
    assert!(switched.opened.pins.is_empty());
    assert!(t.desk.group().is_none(), "不替画师换到别的参考组");
    assert!(!t.group_file(&id).exists());
    let (_, switched) = t.desk.undo_discard(&id, &mut t.history).unwrap();
    let switched = switched.expect("删除时在桌面上，桌面还空着：摆回桌面");
    assert_eq!(switched.opened.pins.len(), 2);
    assert!(switched.opened.problems.is_empty());
    assert_eq!(std::fs::read(t.group_file(&id)).unwrap(), bytes);
    assert_eq!(t.capture_files(&id), captures);
    assert_eq!(ids(&t.desk.lists().unwrap().favorites), [id], "回到常用");
}
