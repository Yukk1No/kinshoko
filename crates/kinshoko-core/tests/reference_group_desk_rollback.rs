//! 桌面上的参考组（#590）续：写盘写到一半失败后不丢组内截图，以及不信任导入的成员身份
//! （#621 上 Codex 的意见）。

#[path = "support/desk.rs"]
mod desk;

use desk::{TestDesk, break_state, reference_pin, reread};
use kinshoko_core::reference_groups::MemberSource;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn capture_file_of(t: &TestDesk, group_id: &str) -> Vec<String> {
    reread(t, group_id)
        .members
        .iter()
        .filter_map(|m| match &m.source {
            MemberSource::Capture { capture_file } => Some(capture_file.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn closing_a_fresh_capture_pin_whose_history_entry_was_deleted_keeps_its_capture() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let pin = t.pin_capture("c", 4);
    let capture = pin.capture_id().unwrap().to_owned();
    // 还没落盘时截图从截图历史删掉：钉着时文件还在。
    t.history.delete(&capture).unwrap();

    t.desk.close(&pin.id, &mut t.history);
    t.desk.flush().unwrap();

    let id = t.desk_id();
    assert_eq!(
        t.capture_files(&id),
        capture_file_of(&t, &id),
        "截图复制进了参考组"
    );
    assert!(t.history.entry(&capture).is_none(), "之后截图历史照常放开");
}

#[test]
fn folding_renames_a_member_whose_id_cannot_name_a_capture_file() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let previous = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_capture("c", 6);
    t.desk.flush().unwrap();
    let source = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();

    // 像导入的参考组包那样，成员身份能跳出目录（截图文件名本身合法）。
    let file = t.group_file(&source);
    let raw = std::fs::read_to_string(&file).unwrap();
    let member = reread(&t, &source).members[0].id.clone();
    let png = format!("{member}.png");
    let raw = raw
        .replace(&png, "\u{0}")
        .replace(&member, "../../victim")
        .replace('\u{0}', &png);
    std::fs::write(&file, raw).unwrap();
    t.restart();

    t.desk.switch_to(&source, &mut t.history).unwrap();
    t.desk
        .fold_into_previous(&previous, &mut t.history)
        .unwrap();

    let escaped = t.root.join("victim.png");
    assert!(!escaped.exists(), "没有写到截图目录外面");
    let files = capture_file_of(&t, &previous);
    assert_eq!(files.len(), 1);
    assert!(!files[0].contains(".."), "换了一个安全的身份：{files:?}");
    assert_eq!(t.capture_files(&previous), files);
}

#[test]
fn a_split_that_cannot_save_the_desk_state_keeps_the_moved_captures() {
    let mut old = String::new();
    let mut t = TestDesk::with(|root| {
        let groups = desk::groups(root);
        let mut pins = vec![reference_pin("old", 10)];
        old = groups.create("旧", &mut pins).unwrap().id;
    });
    t.desk.switch_to(&old, &mut t.history).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    t.pin_capture("n", 8);
    t.desk.flush().unwrap();
    let added = reread(&t, &old)
        .members
        .iter()
        .filter_map(|m| m.added_at)
        .min()
        .unwrap();
    let before = t.capture_files(&old);
    assert_eq!(before.len(), 1);

    let state = break_state(&t);
    assert!(
        t.desk
            .split_off(added..added + DAY, &mut t.history)
            .is_err()
    );
    std::fs::remove_dir_all(&state).unwrap();
    t.desk.flush().unwrap();

    assert_eq!(reread(&t, &old).members.len(), 2, "像没拆过一样");
    assert_eq!(t.capture_files(&old), before, "移走的截图放回了");
    assert_eq!(t.desk.pins().len(), 2);
}

#[test]
fn pruning_that_cannot_save_the_desk_state_keeps_the_captures() {
    let mut t = TestDesk::new();
    let c = t.pin_capture("c", 2);
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    t.desk.close(&c.id, &mut t.history);
    t.desk.flush().unwrap();
    let id = t.desk_id();
    let before = t.capture_files(&id);
    assert_eq!(before.len(), 1);

    let state = break_state(&t);
    assert!(t.desk.prune_unpinned().is_err());
    std::fs::remove_dir_all(&state).unwrap();
    t.desk.flush().unwrap();

    assert_eq!(reread(&t, &id).members.len(), 2);
    assert_eq!(t.capture_files(&id), before, "移出的截图连字节放回");
}

#[test]
fn a_fold_that_cannot_save_the_desk_state_keeps_the_source_captures() {
    let mut t = TestDesk::new();
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let previous = t.desk_id();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_capture("c", 7);
    t.desk.flush().unwrap();
    let source = t.desk_id();
    let before = t.capture_files(&source);
    assert_eq!(before.len(), 1);

    let state = break_state(&t);
    assert!(
        t.desk
            .fold_into_previous(&previous, &mut t.history)
            .is_err()
    );
    std::fs::remove_dir_all(&state).unwrap();
    t.desk.flush().unwrap();

    assert_eq!(t.desk_id(), source, "桌面还是它");
    assert_eq!(t.capture_files(&source), before, "它的截图放回了");
    assert_eq!(capture_file_of(&t, &source), before);
}

#[test]
fn showing_a_member_that_cannot_be_pinned_after_switching_still_reports_the_switch() {
    let mut t = TestDesk::new();
    let c = t.pin_capture("c", 9);
    t.pin_reference("a", 10);
    t.desk.flush().unwrap();
    let capture = c.capture_id().unwrap().to_owned();
    t.desk.close(&c.id, &mut t.history);
    t.desk.flush().unwrap();
    let first = t.desk_id();
    let member = c.member.as_ref().unwrap().member_id.clone();
    t.desk.new_desk(&mut t.history).unwrap();
    t.pin_reference("b", 20);
    t.desk.flush().unwrap();

    // 组内截图和截图历史里的都没了。
    for file in t.capture_files(&first) {
        std::fs::remove_file(
            t.root
                .join("reference-groups")
                .join(format!("{first}.captures"))
                .join(file),
        )
        .unwrap();
    }
    t.history.delete(&capture).unwrap();

    let shown = t.desk.show_member(&first, &member, &mut t.history).unwrap();
    assert_eq!(t.desk_id(), first, "换了桌");
    let switched = shown.switched.expect("换桌交给应用壳");
    assert!(!switched.opened.problems.is_empty(), "钉不出来的原因在里面");
    assert!(shown.opened.is_none());
    assert_eq!(switched.opened.pins.len(), 1, "那组钉着的照样钉出");
}
