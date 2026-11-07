//! pixiv 收藏夹同步（#371）：pixiv 上新收藏的作品下次检查后出现在资料库，旧作品刚收藏的也算；
//! 在 pixiv 取消收藏，资料库里的图不变；首次开启时按选的旧收藏收；公开与非公开收藏都收。

use super::*;

/// 假收藏夹：公开、非公开两条流，每条从最近的收藏往前，每页 `PAGE` 个。
#[derive(Default)]
struct FakeBookmarks {
    feeds: [Vec<Work>; 2],
    images: HashMap<String, Vec<u8>>,
    fail: HashMap<String, SourceError>,
    downloads: Vec<String>,
    /// 读了几页。
    pages_read: usize,
}

const PAGE: usize = 3;

impl FakeBookmarks {
    /// 在某条流里新收藏一个作品（排到最前）。
    fn bookmark(&mut self, feed: usize, work: Work) {
        for url in &work.pages {
            let seed = self.images.len() as u8 + 1;
            self.images.insert(url.clone(), png(seed));
        }
        self.feeds[feed].insert(0, work);
    }

    fn unbookmark(&mut self, id: &str) {
        for feed in &mut self.feeds {
            feed.retain(|w| w.id != id);
        }
    }
}

impl Source for FakeBookmarks {
    fn id(&self) -> SourceId {
        SourceId::Pixiv
    }

    fn works(
        &mut self,
        _: &Subscription,
        _: &mut dyn FnMut(&Work) -> bool,
    ) -> Result<Vec<Work>, SourceError> {
        Err(SourceError::Unsupported)
    }

    fn bookmarks(
        &mut self,
        _: &Subscription,
        enough: &mut dyn FnMut(usize, &[Work]) -> bool,
    ) -> Result<Vec<Vec<Work>>, SourceError> {
        let mut out = Vec::new();
        for (feed, works) in self.feeds.iter().enumerate() {
            let mut listed = Vec::new();
            for page in works.chunks(PAGE) {
                self.pages_read += 1;
                listed.extend_from_slice(page);
                if enough(feed, page) {
                    break;
                }
            }
            out.push(listed);
        }
        Ok(out)
    }

    fn download(&mut self, url: &str) -> Result<Vec<u8>, SourceError> {
        self.downloads.push(url.to_owned());
        if let Some(error) = self.fail.get(url) {
            return Err(error.clone());
        }
        Ok(self.images[url].clone())
    }
}

/// 发布时间很早的作品：收藏夹不看发布时间。
fn old(id: &str) -> Work {
    let mut w = work(id, WorkKind::Illustration, false, 1);
    w.posted_at = 1_000;
    w
}

/// 公开收藏 `public` 个、非公开 `private` 个（id 为 p0…、s0…，序号越小越近）。
fn bookmarks(public: usize, private: usize) -> FakeBookmarks {
    let mut source = FakeBookmarks::default();
    for i in (0..public).rev() {
        source.bookmark(0, old(&format!("p{i}")));
    }
    for i in (0..private).rev() {
        source.bookmark(1, old(&format!("s{i}")));
    }
    source
}

/// 订阅时间晚于所有作品的发布时间。公开与非公开收藏选一样的旧收藏。
fn sync(f: &Fixture, backlog: Backlog, include_explicit: bool) -> Subscription {
    sync_each(f, backlog, None, include_explicit)
}

fn sync_each(
    f: &Fixture,
    backlog: Backlog,
    private_backlog: Option<Backlog>,
    include_explicit: bool,
) -> Subscription {
    f.store
        .add(
            NewSubscription {
                target: Target::PixivBookmarks,
                name: String::new(),
                library_id: f.library().info().id.clone(),
                include_explicit,
                include_manga: false,
                backlog,
                private_backlog,
            },
            *f.clock.borrow(),
        )
        .unwrap()
}

fn check_bookmarks(
    f: &Fixture,
    subscription: &Subscription,
    source: &mut dyn Source,
) -> Result<CheckReport, SourceError> {
    let subscription = f.store.get(&subscription.id).unwrap();
    let now = || {
        let mut t = f.clock.borrow_mut();
        *t += 1;
        *t
    };
    check(
        &f.store,
        &subscription,
        source,
        &f.libraries,
        &now,
        &AtomicBool::new(false),
    )
}

fn later() -> Fixture {
    Fixture::with(Backlog::All, 1_800_000_000_000)
}

fn work_ids(f: &Fixture) -> Vec<String> {
    let mut ids: Vec<String> = f
        .store
        .recent(100)
        .unwrap()
        .into_iter()
        .map(|r| r.work_id)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// 订阅收进来、还在资料库里的图。
fn library_images(f: &Fixture) -> Vec<String> {
    let mut ids: Vec<String> = f
        .store
        .recent(100)
        .unwrap()
        .into_iter()
        .filter(|r| f.library().image(&r.image_id).is_ok())
        .map(|r| r.image_id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn a_new_bookmark_shows_up_in_the_library_after_the_next_check() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, true);
    let mut source = bookmarks(5, 2);

    // 首次只收以后的新收藏：已有的一张不收，只读第一页记下来。
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, 0);
    assert_eq!(source.pages_read, 2);
    assert!(source.downloads.is_empty());

    // 在 pixiv 上收藏一张很早以前发布的作品：下次检查后出现在资料库里。
    source.bookmark(0, old("new"));
    source.bookmark(1, old("secret"));
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, 2);
    assert_eq!(work_ids(&f), ["new", "secret"]);
    let images = library_images(&f);
    assert_eq!(images.len(), 2);

    // 没有新收藏时不再下载。
    source.downloads.clear();
    check_bookmarks(&f, &sub, &mut source).unwrap();
    assert!(source.downloads.is_empty());
}

#[test]
fn unbookmarking_on_pixiv_leaves_collected_images_alone() {
    let f = later();
    let sub = sync(&f, Backlog::All, true);
    let mut source = bookmarks(4, 0);
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 4);
    let before = library_images(&f);

    // 取消收藏最近的两张：资料库不变，也不把更早的收藏当成新的。
    source.unbookmark("p0");
    source.unbookmark("p1");
    source.downloads.clear();
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report, CheckReport::default());
    assert!(source.downloads.is_empty());
    assert_eq!(library_images(&f), before);

    // 之后新收藏的照样收进来。
    source.bookmark(0, old("again"));
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 1);
    assert_eq!(library_images(&f).len(), 5);
}

#[test]
fn removing_every_listed_bookmark_does_not_turn_older_ones_into_new_ones() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, true);
    let mut source = bookmarks(5, 0);
    check_bookmarks(&f, &sub, &mut source).unwrap();

    // 第一页记下的三张全取消收藏：剩下的两张是旧收藏，不收，只重新记下。
    for id in ["p0", "p1", "p2"] {
        source.unbookmark(id);
    }
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, 0);
    source.bookmark(0, old("new"));
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 1);
    assert_eq!(work_ids(&f), ["new"]);
}

#[test]
fn recent_backlog_takes_the_latest_bookmarks_of_each_feed() {
    let f = later();
    let sub = sync(&f, Backlog::Recent { count: 2 }, true);
    let mut source = bookmarks(5, 3);
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, 4);
    assert_eq!(work_ids(&f), ["p0", "p1", "s0", "s1"]);

    // 第一次数到的范围以外的旧收藏，之后也不收。
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, 0);
}

#[test]
fn public_and_private_bookmarks_follow_their_own_backlog() {
    let f = later();
    // 公开收藏只同步以后的新收藏，非公开收藏全部同步。
    let sub = sync_each(&f, Backlog::NewOnly, Some(Backlog::All), true);
    assert_eq!(
        f.store.get(&sub.id).unwrap().private_backlog,
        Some(Backlog::All)
    );
    let mut source = bookmarks(5, 4);
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 4);
    assert_eq!(work_ids(&f), ["s0", "s1", "s2", "s3"]);
}

#[test]
fn bookmarks_follow_the_explicit_option_and_skip_animations() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, false);
    let mut source = bookmarks(1, 0);
    check_bookmarks(&f, &sub, &mut source).unwrap();

    let mut explicit = old("r18");
    explicit.explicit = true;
    let mut animation = old("ugoira");
    animation.kind = WorkKind::Animation;
    animation.pages.clear();
    source.bookmark(0, explicit);
    source.bookmark(0, animation);
    source.bookmark(0, old("safe"));
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!((report.collected, report.skipped), (1, 1));
    assert_eq!(work_ids(&f), ["safe"]);
    assert_eq!(f.store.get(&sub.id).unwrap().skipped, 1);
}

#[test]
fn a_failed_bookmark_is_retried_even_after_newer_ones_are_listed() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, true);
    let mut source = bookmarks(PAGE * 2, 0);
    check_bookmarks(&f, &sub, &mut source).unwrap();

    let flaky = old("flaky");
    source
        .fail
        .insert(flaky.pages[0].clone(), SourceError::Status { status: 500 });
    source.bookmark(0, flaky);
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().failed, 1);

    // 之后又收藏了几张，没收成的那张被挤到后面的页里：照样翻到它，补收进来。
    source.fail.clear();
    for i in 0..PAGE {
        source.bookmark(0, old(&format!("n{i}")));
    }
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, PAGE as u32 + 1);
    assert!(work_ids(&f).contains(&"flaky".to_owned()));
}

#[test]
fn an_unfinished_first_check_starts_over_without_downloading_twice() {
    let f = later();
    let sub = sync(&f, Backlog::All, true);
    let mut source = bookmarks(3, 0);
    // 第二张（从旧往新收）遇到频率限制：这次不算查过。
    source.fail.insert(
        source.feeds[0][1].pages[0].clone(),
        SourceError::RateLimited,
    );
    assert_eq!(
        check_bookmarks(&f, &sub, &mut source),
        Err(SourceError::RateLimited)
    );
    assert_eq!(f.store.get(&sub.id).unwrap().last_checked_at, None);

    source.fail.clear();
    source.downloads.clear();
    let report = check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(report.collected, 2);
    assert_eq!(source.downloads.len(), 2);
    assert_eq!(work_ids(&f), ["p0", "p1", "p2"]);
}

#[test]
fn a_rebookmarked_work_is_not_taken_for_the_old_boundary() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, true);
    let mut source = bookmarks(2, 0);
    check_bookmarks(&f, &sub, &mut source).unwrap();

    // 新收藏 b，再把列出过的 p0 取消收藏后重新收藏：p0 排到 b 前面，b 照样同步进来。
    source.bookmark(0, old("b"));
    source.unbookmark("p0");
    source.bookmark(0, old("p0"));
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 1);
    assert_eq!(work_ids(&f), ["b"]);
}

#[test]
fn a_retried_boundary_work_keeps_the_recent_page_limit() {
    let f = later();
    let sub = sync(&f, Backlog::Recent { count: 2 }, true);
    let mut source = FakeBookmarks::default();
    let mut five = work("five", WorkKind::Illustration, false, 5);
    five.posted_at = 1_000;
    source.bookmark(0, five.clone());
    source
        .fail
        .insert(five.pages[1].clone(), SourceError::Status { status: 500 });
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().failed, 1);

    // 重试时只补第 2 页，不多收后面三页。
    source.fail.clear();
    source.downloads.clear();
    check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(source.downloads, [five.pages[1].clone()]);
    assert_eq!(f.store.recent(10).unwrap().len(), 2);
}

#[test]
fn a_failed_bookmark_that_was_removed_stops_forcing_full_scans() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, true);
    let mut source = bookmarks(PAGE * 3, 0);
    check_bookmarks(&f, &sub, &mut source).unwrap();

    let flaky = old("flaky");
    source
        .fail
        .insert(flaky.pages[0].clone(), SourceError::Status { status: 500 });
    source.bookmark(0, flaky);
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().failed, 1);

    // 取消收藏后：这次翻到底确认它不在了，之后的检查只读第一页。
    source.unbookmark("flaky");
    check_bookmarks(&f, &sub, &mut source).unwrap();
    source.pages_read = 0;
    check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(source.pages_read, 1);
}

#[test]
fn a_lone_surviving_boundary_still_marks_new_bookmarks() {
    let f = later();
    let sub = sync(&f, Backlog::NewOnly, true);
    // 第一页 p0–p2 记下，p3、p4 没读到。
    let mut source = bookmarks(PAGE + 2, 0);
    check_bookmarks(&f, &sub, &mut source).unwrap();

    // 取消收藏 p1、p2，再新收藏 n：[n, p0, p3, p4]，n 照样同步，p3、p4 不当新收藏。
    source.unbookmark("p1");
    source.unbookmark("p2");
    source.bookmark(0, old("n"));
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 1);
    assert_eq!(work_ids(&f), ["n"]);
}

#[test]
fn new_bookmarks_do_not_push_out_an_unfinished_recent_selection() {
    let f = later();
    let sub = sync(&f, Backlog::Recent { count: 2 }, true);
    let mut source = bookmarks(3, 0);
    // 选上 p0、p1；从旧往新收，p1 先下载时断网，这次检查没完成。
    source
        .fail
        .insert(source.feeds[0][1].pages[0].clone(), SourceError::Network);
    assert_eq!(
        check_bookmarks(&f, &sub, &mut source),
        Err(SourceError::Network)
    );

    // 期间新收藏 n：下次检查 n、p0、p1 都同步，p2 不同步。
    source.fail.clear();
    source.bookmark(0, old("n"));
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 3);
    assert_eq!(work_ids(&f), ["n", "p0", "p1"]);
}

#[test]
fn an_unfinished_recent_selection_that_fills_a_page_keeps_its_cutoff() {
    let f = later();
    // 最近 3 张正好是第一页；从旧往新收，第一张 p2 就断网。
    let sub = sync(&f, Backlog::Recent { count: PAGE as u32 }, true);
    let mut source = bookmarks(PAGE + 2, 0);
    source.fail.insert(
        source.feeds[0][PAGE - 1].pages[0].clone(),
        SourceError::Network,
    );
    assert_eq!(
        check_bookmarks(&f, &sub, &mut source),
        Err(SourceError::Network)
    );

    // 下次只补这 3 张，后面两张旧收藏不同步；补完以后不再翻到底。
    source.fail.clear();
    assert_eq!(check_bookmarks(&f, &sub, &mut source).unwrap().collected, 3);
    assert_eq!(work_ids(&f), ["p0", "p1", "p2"]);
    source.pages_read = 0;
    check_bookmarks(&f, &sub, &mut source).unwrap();
    assert_eq!(source.pages_read, 1);
}
