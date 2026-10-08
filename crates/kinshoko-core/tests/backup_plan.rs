//! 自动备份按日调度（#69）：每天（本地日期）第一次退出或空闲时到期；目标不在时记下、提醒，
//! 隔一段时间后的下一次再试。经 `kinshoko_core::backup::BackupPlan`，计划存在临时目录里。

use kinshoko_core::backup::{BackupError, BackupPlan, ScopeSelection, Stamp};

const HOUR: i64 = 60 * 60 * 1000;
/// 2026-10-05 00:00 UTC，东八区 08:00。
const T0: i64 = 1_791_158_400_000;

fn at(hours: i64) -> Stamp {
    Stamp::new(T0 + hours * HOUR, 8 * 60)
}

#[test]
fn nothing_is_due_until_a_target_is_chosen() {
    let dir = tempfile::tempdir().unwrap();
    let mut plan = BackupPlan::open(dir.path()).unwrap();
    assert!(!plan.due(at(0)));
    plan.set_target(Some(&dir.path().join("备份盘"))).unwrap();
    assert!(plan.due(at(0)));
}

#[test]
fn a_successful_backup_is_not_repeated_on_the_same_local_day() {
    let dir = tempfile::tempdir().unwrap();
    let mut plan = BackupPlan::open(dir.path()).unwrap();
    plan.set_target(Some(&dir.path().join("备份盘"))).unwrap();
    plan.record_success(at(2), "s1").unwrap(); // 本地 10:00
    assert!(!plan.due(at(13)), "本地 21:00，同一天");
    assert!(plan.due(at(16)), "本地次日 00:00");

    // 记录跨进程保留。
    let reopened = BackupPlan::open(dir.path()).unwrap();
    assert!(!reopened.due(at(13)));
    let view = reopened.view(at(13));
    assert_eq!(view.last_snapshot.as_deref(), Some("s1"));
    assert_eq!(view.selection, ScopeSelection::All);
}

#[test]
fn a_missing_target_is_remembered_for_a_reminder_and_retried_next_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut plan = BackupPlan::open(dir.path()).unwrap();
    plan.set_target(Some(&dir.path().join("备份盘"))).unwrap();
    plan.record_failure(
        at(1),
        &BackupError::TargetUnavailable(dir.path().join("备份盘")),
    )
    .unwrap();
    let view = plan.view(at(1));
    let failure = view.last_failure.expect("提醒画师");
    assert!(failure.target_unavailable);
    assert!(failure.reason.contains("备份目标不在"));
    assert!(!plan.due(at(1)), "刚失败不马上重试");
    assert!(plan.due(at(2)), "下一次退出或空闲时再试");

    plan.record_success(at(3), "s2").unwrap();
    assert!(plan.view(at(3)).last_failure.is_none(), "成功后不再提醒");
}

#[test]
fn choosing_another_target_makes_a_backup_due_again_today() {
    let dir = tempfile::tempdir().unwrap();
    let mut plan = BackupPlan::open(dir.path()).unwrap();
    plan.set_target(Some(&dir.path().join("盘一"))).unwrap();
    plan.record_success(at(2), "s1").unwrap();
    plan.set_target(Some(&dir.path().join("盘二"))).unwrap();
    assert!(plan.due(at(3)));
    plan.set_target(None).unwrap();
    assert!(!plan.due(at(3)));
}
