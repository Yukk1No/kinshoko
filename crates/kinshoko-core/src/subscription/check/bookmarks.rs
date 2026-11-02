//! 检查 pixiv 收藏夹（#371）。收藏夹按收藏先后排，旧作品也可能是刚收藏的，所以不看发布时间：
//! 每条收藏流从最近的收藏往前翻，翻到连着两个列出过的作品就停，比它们近、没列出过的才是新收藏。一般不认单独
//! 一个列出过的作品：取消收藏后又重新收藏的作品会单独排到前面，它不是上次的边界。只有它后面再没有列出过的
//! 作品时（上次的边界只剩它一个），才认它。
//! 在 pixiv 上取消收藏只是让它不再列出，已收进资料库的图不动。
//!
//! - 第一次检查时公开、非公开收藏各按画师选的旧收藏定：只同步以后的新收藏时只读第一页；最近若干张时收这条流
//!   最近这么多张；全部时整条流都收。下载前先把读到的都记为列出过，定下基线，选上的另记为待收（同重试）：
//!   第一次没查完时，下次照常从基线往前认新收藏，并把选上、还没下完的找回来接着收。
//! - 检查成功后，这次列出的作品都记为列出过；没收成、还要重试的除外，下次翻到底把它们找回来。翻到底也
//!   没找到的（已取消收藏）不再重试。最近若干张数到的最后一个作品只收前几页，记下页数，重试时也照它。
//! - 一条流里列出过的作品全被取消收藏、翻到底也没遇到时，不把剩下的旧收藏当成新的，只重新记下。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use super::{CheckReport, Destination, Source, SourceError, Work, receive, wanted};
use crate::subscription::store::{Store, StoreError, WorkKey};
use crate::subscription::{Backlog, SourceId, Subscription};

pub(super) fn run(
    store: &Store,
    subscription: &Subscription,
    source: &mut dyn Source,
    destination: &dyn Destination,
    now: &dyn Fn() -> i64,
    cancel: &AtomicBool,
) -> Result<CheckReport, SourceError> {
    let id = subscription.id.as_str();
    let first = !store.bookmarks_baseline(id)?;
    let retry = store.retry_works(id)?;
    let source_id = source.id();
    let mut store_failed = false;
    let mut is_known = |work: &Work| -> bool {
        known(store, subscription, source_id, work).unwrap_or_else(|_| {
            store_failed = true;
            true
        })
    };
    let mut counted: HashMap<usize, u32> = HashMap::new();
    // 每条流上一页最后一个作品是否列出过：边界可能跨页。
    let mut last_known: HashMap<usize, bool> = HashMap::new();
    let feeds = source.bookmarks(subscription, &mut |feed, page| {
        // 有要重试的作品：翻到底把它们找回来。
        if !retry.is_empty() {
            return false;
        }
        if !first {
            let mut flags: Vec<bool> = last_known.get(&feed).copied().into_iter().collect();
            let skip = flags.len();
            flags.extend(page.iter().map(&mut is_known));
            last_known.insert(feed, flags.last().copied().unwrap_or(false));
            return flags
                .windows(2)
                .enumerate()
                .any(|(at, w)| at + 1 >= skip && w[0] && w[1]);
        }
        match backlog(subscription, feed) {
            Backlog::NewOnly => true,
            Backlog::All => false,
            Backlog::Recent { count } => {
                let seen = counted.entry(feed).or_default();
                for work in page.iter().filter(|w| wanted(subscription, w)) {
                    *seen += work.pages.len() as u32;
                }
                *seen >= count
            }
        }
    })?;
    if store_failed {
        return Err(SourceError::Store);
    }

    let mut chosen = Vec::new();
    for (feed, works) in feeds.iter().enumerate() {
        let mut candidates: Vec<Work> = if first {
            match backlog(subscription, feed) {
                Backlog::NewOnly => Vec::new(),
                Backlog::All => works.clone(),
                Backlog::Recent { count } => {
                    let taken = recent(subscription, works, count);
                    for (work, full) in taken.iter().zip(works) {
                        if work.pages.len() < full.pages.len() {
                            store.set_page_limit(id, &work.id, work.pages.len() as u32)?;
                        }
                    }
                    taken
                }
            }
        } else {
            let flags = works
                .iter()
                .map(|w| known(store, subscription, source_id, w))
                .collect::<Result<Vec<bool>, _>>()?;
            match boundary(&flags) {
                Some(at) => works[..at]
                    .iter()
                    .zip(&flags)
                    .filter(|(_, known)| !**known)
                    .map(|(w, _)| w.clone())
                    .collect(),
                None if store.feed_listed(id, feed)? => Vec::new(),
                None => works.clone(),
            }
        };
        let taken: HashSet<String> = candidates.iter().map(|w| w.id.clone()).collect();
        candidates.extend(
            works
                .iter()
                .filter(|w| retry.contains(&w.id) && !taken.contains(&w.id))
                .cloned(),
        );
        for work in &mut candidates {
            if let Some(pages) = store.page_limit(id, &work.id)? {
                work.pages.truncate(pages as usize);
            }
        }
        chosen.push(candidates);
    }
    if first {
        for (feed, (works, candidates)) in feeds.iter().zip(&chosen).enumerate() {
            store.mark_listed(id, feed, works.iter().map(|w| w.id.as_str()))?;
            store.add_pending(id, source_id, candidates.iter().map(|w| w.id.as_str()))?;
        }
        store.set_bookmarks_baseline(id, now())?;
    }

    let mut report = CheckReport::default();
    for candidates in &chosen {
        // 从旧到新收，最近收进来的图按时间排列时与收藏的先后一致。
        for work in candidates.iter().rev() {
            let failed = report.failed;
            receive(
                store,
                subscription,
                work,
                source,
                destination,
                now,
                cancel,
                &mut report,
            )?;
            // 处理完了（收了、跳过或按选项不收）：不再待收。
            if report.failed == failed && !store.gave_up(id, source_id, &work.id)? {
                store.clear_failure(id, source_id, &work.id)?;
            }
        }
    }

    // 有要重试的作品时翻过了整个收藏夹：两条流里都没有的已取消收藏，不再重试。
    if !retry.is_empty() {
        let present: HashSet<&str> = feeds.iter().flatten().map(|w| w.id.as_str()).collect();
        for work_id in retry.iter().filter(|w| !present.contains(w.as_str())) {
            store.clear_failure(id, source_id, work_id)?;
        }
    }
    let retry = store.retry_works(id)?;
    for (feed, works) in feeds.iter().enumerate() {
        store.mark_listed(
            id,
            feed,
            works
                .iter()
                .map(|w| w.id.as_str())
                .filter(|w| !retry.contains(*w)),
        )?;
    }
    Ok(report)
}

/// 某条收藏流第一次检查时按的旧收藏选项：公开收藏按 `backlog`，非公开收藏按 `private_backlog`。
fn backlog(subscription: &Subscription, feed: usize) -> Backlog {
    match feed {
        0 => subscription.backlog,
        _ => subscription.private_backlog.unwrap_or(subscription.backlog),
    }
}

/// 新旧收藏的边界：第一个列出过、且紧跟着的也列出过的作品；它后面再没有列出过的作品（包括它是最后一个）时
/// 也算。
fn boundary(known: &[bool]) -> Option<usize> {
    (0..known.len()).find(|&at| {
        known[at]
            && (known.get(at + 1).copied().unwrap_or(true) || !known[at + 1..].contains(&true))
    })
}

/// 这条订阅列出过或收过这个作品。
fn known(
    store: &Store,
    subscription: &Subscription,
    source: SourceId,
    work: &Work,
) -> Result<bool, StoreError> {
    let key = WorkKey {
        library_id: &subscription.library_id,
        source,
        work_id: &work.id,
    };
    Ok(store.listed(&subscription.id, &work.id)? || store.received_by(&subscription.id, &key)?)
}

/// 最近若干张：从最近的收藏往前数够 `count` 张（按页计），最后一个作品超出的页不收；其间不收的作品
/// （例如动图，照样记为已跳过）也列进来。
fn recent(subscription: &Subscription, works: &[Work], count: u32) -> Vec<Work> {
    let mut left = count;
    let mut out = Vec::new();
    for work in works {
        if left == 0 {
            break;
        }
        let mut work = work.clone();
        if wanted(subscription, &work) {
            let take = (work.pages.len() as u32).min(left);
            work.pages.truncate(take as usize);
            left -= take;
        }
        out.push(work);
    }
    out
}
