//! 把已关闭的成员钉回来（#588 11-19 晚）：关闭时间、全部钉上、点成员钉出；换桌时拉回屏幕。

#[path = "support/desk.rs"]
mod desk;

use desk::{TestDesk, assert_matches, reread, screen};

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
    assert_eq!(back.opened.pins[0].placement.x, 9000, "换桌只按存下的位置钉出");
    assert!(t.desk.pull_onto_screen(&[screen()]));
    let pin = t.desk.pins()[0].clone();
    assert!(pin.placement.x < 3840 && pin.placement.y < 2160, "拉回了屏幕");
    assert!(!t.desk.pull_onto_screen(&[screen()]), "已在屏幕上的不再动");
    t.desk.flush().unwrap();
    assert_eq!(reread(&t, &id).members[0].placement, pin.placement, "成员的摆放跟着改");
}
