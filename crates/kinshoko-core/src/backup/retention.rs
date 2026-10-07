//! 快照保留：最近 7 份每日快照（每个本地日期最新的一份，取最近 7 天）＋ 4 份每周快照
//! （在每日快照之前的快照里，每周最新的一份，取最近 4 周）。

use std::collections::BTreeSet;

use super::Stamp;

pub(super) const DAILY: usize = 7;
pub(super) const WEEKLY: usize = 4;

/// 要保留的快照下标。
pub(super) fn keep(snapshots: &[Stamp]) -> BTreeSet<usize> {
    let mut order: Vec<usize> = (0..snapshots.len()).collect();
    // 新的在前。
    order.sort_by_key(|&i| std::cmp::Reverse(snapshots[i].unix_ms));

    let mut kept = BTreeSet::new();
    let mut days = BTreeSet::new();
    let mut oldest_daily = i64::MAX;
    for &i in &order {
        if days.len() == DAILY {
            break;
        }
        if days.insert(snapshots[i].local_day()) {
            kept.insert(i);
            oldest_daily = oldest_daily.min(snapshots[i].unix_ms);
        }
    }
    let mut weeks = BTreeSet::new();
    for &i in &order {
        if weeks.len() == WEEKLY {
            break;
        }
        if snapshots[i].unix_ms >= oldest_daily {
            continue;
        }
        if weeks.insert(snapshots[i].local_week()) {
            kept.insert(i);
        }
    }
    kept
}
