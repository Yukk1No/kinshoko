//! 亲手收进资料库（#461 第 3 步）：画师在应用内浏览里挑的作品，收整个作品或多页作品的某几页。
//!
//! 作者、作品标签、来源链接与成人分级同订阅收进来的图（同一个 [`Destination`]）；动图跳过。
//! 已收的页不再收，除非画师明确要求再收一次（例如图在资料库里被删掉了）。收过以后自动订阅把这个
//! 作品当作已收，不再收第二份。

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::SourceId;
use super::check::{Destination, SourceError, Work, WorkKind, original_name};
use super::store::{BY_HAND, Outcome, Store, WorkKey};
use crate::library::SubscriptionPage;

/// 一次亲手收图的结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HandReport {
    /// 这次收进来的页。
    pub collected: u32,
    /// 之前已收、这次没再收的页。
    pub already: u32,
    /// 没收成的页（下载或导入失败），可以再试。
    pub failed: u32,
    /// 动图，不收。
    pub skipped: bool,
}

/// 把 `work` 的 `pages`（为空时全部页）收进 `library_id`。`again` 为真时已收的页也重新下载导入
/// （资料库里有字节相同的图时只合并来源，不会多出一份）。`download` 取一页原图。
///
/// 频率限制、登录问题与取消让这次收图停下，已收的页留着；单页下载或导入失败只记进 `failed`。
#[allow(clippy::too_many_arguments)]
pub fn collect_by_hand(
    store: &Store,
    source: SourceId,
    library_id: &str,
    work: &Work,
    pages: Option<&[u32]>,
    again: bool,
    download: &mut dyn FnMut(&str) -> Result<Vec<u8>, SourceError>,
    destination: &dyn Destination,
    now: &dyn Fn() -> i64,
    cancel: &AtomicBool,
) -> Result<HandReport, SourceError> {
    let key = WorkKey {
        library_id,
        source,
        work_id: &work.id,
    };
    let mut report = HandReport::default();
    if work.kind == WorkKind::Animation {
        store.record_work(
            &key,
            BY_HAND,
            Outcome::SkippedAnimation,
            work.explicit,
            now(),
        )?;
        report.skipped = true;
        return Ok(report);
    }
    let wanted: BTreeSet<u32> = match pages {
        Some(pages) => pages
            .iter()
            .copied()
            .filter(|page| (*page as usize) < work.pages.len())
            .collect(),
        None => (0..work.pages.len() as u32).collect(),
    };
    let done = store.received_pages(&key)?;
    for page in wanted {
        if done.contains(&page) && !again {
            report.already += 1;
            continue;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(SourceError::Cancelled);
        }
        let url = &work.pages[page as usize];
        // 这一页没有原图地址：页序照旧，算没收成。
        if url.is_empty() {
            report.failed += 1;
            continue;
        }
        let bytes = match download(url) {
            Ok(bytes) => bytes,
            Err(error) if error.stops_check() => return Err(error),
            Err(_) => {
                report.failed += 1;
                continue;
            }
        };
        let info = SubscriptionPage {
            source: source.as_str().to_owned(),
            work_id: work.id.clone(),
            page,
            original_name: original_name(&work.id, page, url),
            page_url: work.page_url.clone(),
            author: work.author.clone(),
            tags: work.tags.clone(),
            explicit: work.explicit,
            collected_at: work.posted_at,
        };
        let Ok(image_id) = destination.import(library_id, info, &bytes) else {
            report.failed += 1;
            continue;
        };
        store.record_page(&key, page, &image_id, now())?;
        // 订阅已收过这个作品时保留它的记录（只补页）。
        store.record_work(&key, BY_HAND, Outcome::Collected, work.explicit, now())?;
        report.collected += 1;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::subscription::store::CollectedWork;

    /// 记下导入了什么；`fail` 里的页导入失败。
    #[derive(Default)]
    struct Shelf {
        imported: RefCell<Vec<(String, SubscriptionPage)>>,
        fail: Vec<u32>,
    }

    impl Destination for Shelf {
        fn import(
            &self,
            library_id: &str,
            page: SubscriptionPage,
            _bytes: &[u8],
        ) -> Result<String, String> {
            if self.fail.contains(&page.page) {
                return Err("坏图".into());
            }
            let id = format!("img-{}-{}", page.work_id, page.page);
            self.imported
                .borrow_mut()
                .push((library_id.to_owned(), page));
            Ok(id)
        }
    }

    fn work(id: &str, kind: WorkKind, pages: usize) -> Work {
        Work {
            id: id.into(),
            kind,
            explicit: true,
            author: Some("画师".into()),
            tags: vec!["オリジナル".into()],
            page_url: format!("https://www.pixiv.net/artworks/{id}"),
            pages: (0..pages)
                .map(|p| format!("https://i.pximg.net/img-original/img/{id}_p{p}.png"))
                .collect(),
            posted_at: 1000,
        }
    }

    fn run(
        store: &Store,
        shelf: &Shelf,
        work: &Work,
        pages: Option<&[u32]>,
        again: bool,
    ) -> Result<HandReport, SourceError> {
        collect_by_hand(
            store,
            SourceId::Pixiv,
            "lib",
            work,
            pages,
            again,
            &mut |url| Ok(url.as_bytes().to_vec()),
            shelf,
            &|| 5,
            &AtomicBool::new(false),
        )
    }

    #[test]
    fn collects_the_chosen_pages_with_the_same_facts_as_subscriptions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let shelf = Shelf::default();
        let w = work("7", WorkKind::Manga, 3);
        let report = run(&store, &shelf, &w, Some(&[2, 0, 9]), false).unwrap();
        assert_eq!(report.collected, 2);
        let imported = shelf.imported.borrow();
        let (library, first) = &imported[0];
        assert_eq!(library, "lib");
        assert_eq!(first.page, 0);
        assert_eq!(first.original_name, "7_p0.png");
        assert_eq!(first.author.as_deref(), Some("画师"));
        assert!(first.explicit);
        assert_eq!(first.source, "pixiv");
        assert_eq!(
            store
                .collected(SourceId::Pixiv, &["7".into(), "8".into()])
                .unwrap(),
            vec![CollectedWork {
                work_id: "7".into(),
                library_id: "lib".into(),
                pages: vec![0, 2],
            }]
        );
    }

    #[test]
    fn collected_pages_are_not_collected_again_unless_asked() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let shelf = Shelf::default();
        let w = work("7", WorkKind::Illustration, 2);
        run(&store, &shelf, &w, Some(&[0]), false).unwrap();
        let report = run(&store, &shelf, &w, None, false).unwrap();
        assert_eq!((report.collected, report.already), (1, 1));
        assert_eq!(shelf.imported.borrow().len(), 2);
        // 图在资料库里被删掉了：画师可以再收。
        let report = run(&store, &shelf, &w, Some(&[0]), true).unwrap();
        assert_eq!((report.collected, report.already), (1, 0));
    }

    #[test]
    fn animations_are_skipped_and_failures_reported() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let shelf = Shelf {
            fail: vec![1],
            ..Shelf::default()
        };
        let report = run(
            &store,
            &shelf,
            &work("1", WorkKind::Animation, 1),
            None,
            false,
        )
        .unwrap();
        assert!(report.skipped);
        assert!(
            store
                .collected(SourceId::Pixiv, &["1".into()])
                .unwrap()
                .is_empty()
        );
        let report = run(
            &store,
            &shelf,
            &work("2", WorkKind::Illustration, 2),
            None,
            false,
        )
        .unwrap();
        assert_eq!((report.collected, report.failed), (1, 1));
        // 没有原图地址的页算没收成，后面的页还是原来的页号。
        let mut gap = work("3", WorkKind::Manga, 3);
        gap.pages[1].clear();
        let report = run(&store, &Shelf::default(), &gap, None, false).unwrap();
        assert_eq!((report.collected, report.failed), (2, 1));
        assert_eq!(
            store.collected(SourceId::Pixiv, &["3".into()]).unwrap()[0].pages,
            vec![0, 2]
        );
    }

    #[test]
    fn hand_picked_works_are_not_new_and_stay_out_of_the_subscription_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        run(
            &store,
            &Shelf::default(),
            &work("7", WorkKind::Illustration, 1),
            None,
            false,
        )
        .unwrap();
        assert_eq!(store.new_count(true).unwrap(), 0);
        assert!(store.recent(10).unwrap().is_empty());
        // 自动订阅把它当作已收。
        let key = WorkKey {
            library_id: "lib",
            source: SourceId::Pixiv,
            work_id: "7",
        };
        assert!(store.is_received(&key).unwrap());
    }

    #[test]
    fn rate_limits_stop_and_keep_what_was_collected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let w = work("7", WorkKind::Manga, 3);
        let mut calls = 0;
        let result = collect_by_hand(
            &store,
            SourceId::Pixiv,
            "lib",
            &w,
            None,
            false,
            &mut |url| {
                calls += 1;
                if calls == 2 {
                    Err(SourceError::RateLimited)
                } else {
                    Ok(url.as_bytes().to_vec())
                }
            },
            &Shelf::default(),
            &|| 5,
            &AtomicBool::new(false),
        );
        assert_eq!(result, Err(SourceError::RateLimited));
        assert_eq!(
            store.collected(SourceId::Pixiv, &["7".into()]).unwrap()[0].pages,
            vec![0]
        );
    }
}
