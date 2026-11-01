//! 检查一条订阅：向订阅来源要作品，跳过收过的，下载没收的页并收进资料库。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::store::{Outcome, Store, StoreError, WorkKey};
use super::{Backlog, SourceId, Subscription};
use crate::library::SubscriptionPage;

/// 作品类型（#366）：插画收全部页；漫画按订阅的设置；动图跳过。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkKind {
    Illustration,
    Manga,
    Animation,
}

/// 订阅来源上的一个作品。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Work {
    pub id: String,
    pub kind: WorkKind,
    /// 来源标为成人内容（pixiv 的 R-18 / R-18G）。
    pub explicit: bool,
    pub author: Option<String>,
    /// 来源上的作品标签原文。
    pub tags: Vec<String>,
    /// 作品页链接。
    pub page_url: String,
    /// 每页原图的下载地址。
    pub pages: Vec<String>,
    /// 发布时间（Unix 毫秒）。
    pub posted_at: i64,
}

/// 检查没能完成的原因。以代码交给界面，由界面按语言说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[ts(export)]
pub enum SourceError {
    /// 订阅来源限制了请求频率；整个来源退避。
    RateLimited,
    /// 需要登录，但还没登录。
    LoginRequired,
    /// 登录失效（例如画师在 pixiv 上改了密码），要重新登录。
    LoginExpired,
    /// 网络不通或来源没有响应。
    Network,
    /// 来源回了意料之外的状态码。
    Status { status: u16 },
    /// 来源回的内容读不懂（接口变了）。
    Unreadable,
    /// 这个版本还不支持这种订阅对象。
    Unsupported,
    /// 订阅记录读写失败。
    Store,
    /// 检查被取消（关闭订阅功能或退出）。
    Cancelled,
}

impl From<StoreError> for SourceError {
    fn from(_: StoreError) -> Self {
        SourceError::Store
    }
}

impl SourceError {
    /// 遇到它时后面的作品也不用再试，整次检查停下。
    fn stops_check(&self) -> bool {
        !matches!(self, SourceError::Status { .. } | SourceError::Unreadable)
    }
}

/// 一个订阅来源。
pub trait Source {
    fn id(&self) -> SourceId;

    /// 订阅对象的作品，从新到旧。`enough` 对某个作品回真时（例如它已收过，或已经数够），来源可以
    /// 就此停止往下翻页，这个作品照样列出。来源分几条作品流翻页时（例如画师的插画与漫画），
    /// 每条各自停，合起来仍从新到旧。
    fn works(
        &mut self,
        subscription: &Subscription,
        enough: &mut dyn FnMut(&Work) -> bool,
    ) -> Result<Vec<Work>, SourceError>;

    /// 下载一页原图。
    fn download(&mut self, url: &str) -> Result<Vec<u8>, SourceError>;
}

/// 把下载的图收进资料库；返回参考图 id，失败时返回原因。
pub trait Destination {
    fn import(
        &self,
        library_id: &str,
        page: SubscriptionPage,
        bytes: &[u8],
    ) -> Result<String, String>;
}

/// 一次检查收了多少。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckReport {
    /// 新收进来的图（按页计）。
    pub collected: u32,
    /// 跳过的作品（动图）。
    pub skipped: u32,
    /// 没收成、下次再试的作品。
    pub failed: u32,
}

/// 检查一条订阅。成功时记下检查时间；没完成时只记下原因，不算检查过，下次照常到期。
/// 频率限制、登录问题与取消会让整次检查停下；单个作品下载或导入失败只跳过它，下次再试。
pub fn check(
    store: &Store,
    subscription: &Subscription,
    source: &mut dyn Source,
    destination: &dyn Destination,
    now: &dyn Fn() -> i64,
    cancel: &AtomicBool,
) -> Result<CheckReport, SourceError> {
    let result = run(store, subscription, source, destination, now, cancel);
    let recorded = match &result {
        Ok(_) => store.mark_checked(&subscription.id, now()),
        Err(SourceError::Cancelled) => Ok(()),
        Err(error) => store.note_error(&subscription.id, error, now()),
    };
    match (result, recorded) {
        (Ok(report), Ok(())) => Ok(report),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn run(
    store: &Store,
    subscription: &Subscription,
    source: &mut dyn Source,
    destination: &dyn Destination,
    now: &dyn Fn() -> i64,
    cancel: &AtomicBool,
) -> Result<CheckReport, SourceError> {
    let source_id = source.id();
    let library_id = subscription.library_id.as_str();
    let since = subscription.since;
    // 选了“最近若干张”、第一次还没查完：数够这么多张为止，收过的不算停下的理由（已收的也算在数里）。
    let window = match subscription.backlog {
        Backlog::Recent { count } if since.is_none() => Some(count),
        _ => None,
    };
    let mut store_failed = false;
    // 有待重试的作品时，不让来源在比它新的已收作品处停下，否则它轮不到重试。
    let retrying = store.has_failed(&subscription.id)?;
    let mut counted: HashMap<WorkKind, u32> = HashMap::new();
    let works = source.works(subscription, &mut |work| {
        if since.is_some_and(|since| work.posted_at < since) {
            return true;
        }
        if let Some(count) = window {
            if !wanted(subscription, work) {
                return false;
            }
            // 每条作品流只有一种作品类型，按类型各自数。
            let seen = counted.entry(work.kind).or_default();
            *seen += work.pages.len() as u32;
            return *seen >= count;
        }
        if retrying {
            return false;
        }
        let key = WorkKey {
            library_id,
            source: source_id,
            work_id: &work.id,
        };
        store
            .received_by(&subscription.id, &key)
            .unwrap_or_else(|_| {
                store_failed = true;
                true
            })
    })?;
    if store_failed {
        return Err(SourceError::Store);
    }
    let works: Vec<Work> = works
        .into_iter()
        .filter(|w| since.is_none_or(|since| w.posted_at >= since))
        .collect();
    // 窗口一算出来就记下，之后（包括这次没收完的重试）都按它收，新发的作品不会把没收完的挤出去。
    let (works, boundary) = match window {
        Some(count) => {
            let (works, cutoff, boundary) = take_recent(subscription, works, count);
            let boundary = boundary.map(|(work, pages)| (work.to_owned(), pages));
            store.set_window(
                &subscription.id,
                cutoff,
                boundary
                    .as_ref()
                    .map(|(work, pages)| (work.as_str(), *pages)),
            )?;
            (works, boundary)
        }
        None => (works, store.boundary(&subscription.id)?),
    };
    let works: Vec<Work> = works
        .into_iter()
        .map(|mut work| {
            if let Some((_, pages)) = boundary.as_ref().filter(|(id, _)| *id == work.id) {
                work.pages.truncate(*pages as usize);
            }
            work
        })
        .collect();
    let mut report = CheckReport::default();
    // 从旧到新收，最近收进来的图按时间排列时与来源上的先后一致。
    for work in works.iter().rev() {
        // 检查期间画师退订了：剩下的不再收。
        if cancel.load(Ordering::SeqCst) || !store.exists(&subscription.id)? {
            return Err(SourceError::Cancelled);
        }
        let key = WorkKey {
            library_id,
            source: source_id,
            work_id: &work.id,
        };
        if store.is_received(&key)? {
            // 别的订阅已把它收进同一个资料库：本条不用再重试它。
            store.clear_failure(&subscription.id, source_id, &work.id)?;
            continue;
        }
        match work.kind {
            WorkKind::Animation => {
                store.record_work(
                    &key,
                    &subscription.id,
                    Outcome::SkippedAnimation,
                    work.explicit,
                    now(),
                )?;
                report.skipped += 1;
                continue;
            }
            WorkKind::Manga if !subscription.include_manga => continue,
            _ if work.explicit && !subscription.include_explicit => continue,
            _ => {}
        }
        if store.gave_up(&subscription.id, source_id, &work.id)? {
            continue;
        }
        match collect(store, subscription, &key, work, source, destination, now)? {
            Some(pages) => {
                store.clear_failure(&subscription.id, source_id, &work.id)?;
                store.record_work(
                    &key,
                    &subscription.id,
                    Outcome::Collected,
                    work.explicit,
                    now(),
                )?;
                report.collected += pages;
            }
            None => {
                store.record_failure(&subscription.id, source_id, &work.id)?;
                report.failed += 1;
            }
        }
    }
    Ok(report)
}

/// 这条订阅要不要收这个作品（动图、没打开的漫画与成人作品不收）。
fn wanted(subscription: &Subscription, work: &Work) -> bool {
    match work.kind {
        WorkKind::Animation => false,
        WorkKind::Manga if !subscription.include_manga => false,
        _ => !work.explicit || subscription.include_explicit,
    }
}

/// 最近若干张：从新到旧数够 `count` 张（按页计），最后一个作品超出的页不收。返回要处理的作品
/// （其间的动图照样记为已跳过）、此后的下限（数到的最后一张的发布时间；不够这么多张时为最早），
/// 以及被截断的那个作品与它收的页数。
fn take_recent(
    subscription: &Subscription,
    works: Vec<Work>,
    count: u32,
) -> (Vec<Work>, i64, Option<(String, u32)>) {
    let mut left = count;
    let mut cutoff = i64::MIN;
    let mut boundary = None;
    let mut out = Vec::new();
    for mut work in works {
        if left == 0 {
            break;
        }
        if wanted(subscription, &work) {
            let take = (work.pages.len() as u32).min(left);
            if (take as usize) < work.pages.len() {
                boundary = Some((work.id.clone(), take));
            }
            work.pages.truncate(take as usize);
            left -= take;
            cutoff = work.posted_at;
        }
        out.push(work);
    }
    (out, if left == 0 { cutoff } else { i64::MIN }, boundary)
}

/// 收一个作品还没收的页；返回这次收了几页，某页失败时为空（已收的页留着，下次补其余的）。
fn collect(
    store: &Store,
    subscription: &Subscription,
    key: &WorkKey<'_>,
    work: &Work,
    source: &mut dyn Source,
    destination: &dyn Destination,
    now: &dyn Fn() -> i64,
) -> Result<Option<u32>, SourceError> {
    let done = store.received_pages(key)?;
    let mut collected = 0;
    for (page, url) in work.pages.iter().enumerate() {
        let page = page as u32;
        if done.contains(&page) {
            continue;
        }
        let bytes = match source.download(url) {
            Ok(bytes) => bytes,
            Err(error) if error.stops_check() => return Err(error),
            Err(_) => return Ok(None),
        };
        let page_info = SubscriptionPage {
            source: key.source.as_str().to_owned(),
            work_id: work.id.clone(),
            page,
            original_name: original_name(&work.id, page, url),
            page_url: work.page_url.clone(),
            author: work.author.clone(),
            tags: work.tags.clone(),
            explicit: work.explicit,
            collected_at: work.posted_at,
        };
        let Ok(image_id) = destination.import(&subscription.library_id, page_info, &bytes) else {
            return Ok(None);
        };
        store.record_page(key, page, &image_id, now())?;
        collected += 1;
    }
    Ok(Some(collected))
}

/// 原文件名：沿用下载地址的文件名（pixiv 为 `<作品 id>_p<页>.<扩展名>`）。
fn original_name(work_id: &str, page: u32, url: &str) -> String {
    url.rsplit('/')
        .next()
        .map(|name| name.split(['?', '#']).next().unwrap_or(name))
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{work_id}_p{page}"))
}
