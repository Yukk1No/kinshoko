//! 检查 pixiv 收藏夹（#371）。收藏夹按收藏先后排，旧作品也可能是刚收藏的，所以不看发布时间：
//! 每条收藏流从最近的收藏往前翻，翻到列出过的作品就停，比它近的才是新收藏。在 pixiv 上取消收藏
//! 只是让它不再列出，已收进资料库的图不动。
//!
//! - 第一次检查按选的旧收藏定：只收以后的新收藏时只读第一页记下来；最近若干张时每条流各收最近
//!   这么多张；全部时整个收藏夹都收。第一次没查完时下次重来，收过的不再下载。
//! - 检查成功后，这次列出的作品都记为列出过；没收成、还要重试的除外，下次翻到底把它们找回来。
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
    let first = subscription.last_checked_at.is_none();
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
    let feeds = source.bookmarks(subscription, &mut |feed, page| {
        // 有要重试的作品：翻到底把它们找回来。
        if !retry.is_empty() {
            return false;
        }
        if !first {
            return page.iter().any(&mut is_known);
        }
        match subscription.backlog {
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

    let mut report = CheckReport::default();
    for (feed, works) in feeds.iter().enumerate() {
        let mut candidates: Vec<Work> = if first {
            match subscription.backlog {
                Backlog::NewOnly => Vec::new(),
                Backlog::All => works.clone(),
                Backlog::Recent { count } => recent(subscription, works, count),
            }
        } else {
            let mut cut = None;
            for (at, work) in works.iter().enumerate() {
                if known(store, subscription, source_id, work)? {
                    cut = Some(at);
                    break;
                }
            }
            match cut {
                Some(at) => works[..at].to_vec(),
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
        // 从旧到新收，最近收进来的图按时间排列时与收藏的先后一致。
        for work in candidates.iter().rev() {
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

/// 这条订阅列出过或收过这个作品：翻到它就停。
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
