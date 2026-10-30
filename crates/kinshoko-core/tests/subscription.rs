//! 订阅地基（#368）：检查一条订阅收进来的图带作者、来源链接、来源标签与成人分级；
//! 收过的作品（包括被删掉的）不再下载；动图跳过并记下；频率限制让整次检查停下；
//! 退出期间错过的检查在重新打开后补上。订阅来源用假的，资料库用临时目录里的真库。

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::AtomicBool;

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{ContentRating, ImageEdit, SubscriptionPage, TagNamespace};
use kinshoko_core::subscription::{
    CheckReport, Destination, NewSubscription, Source, SourceError, SourceId, Store, Subscription,
    Target, Work, WorkKind, check, schedule,
};

fn png(seed: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    RgbaImage::from_fn(4, 4, |x, y| image::Rgba([seed, x as u8, y as u8, 255]))
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

fn work(id: &str, kind: WorkKind, explicit: bool, pages: usize) -> Work {
    Work {
        id: id.into(),
        kind,
        explicit,
        author: Some("某画师".into()),
        tags: vec!["オリジナル".into(), "女の子".into()],
        page_url: format!("https://www.pixiv.net/artworks/{id}"),
        pages: (0..pages)
            .map(|p| format!("https://i.pximg.net/img-original/{id}_p{p}.png"))
            .collect(),
        posted_at: 1_709_251_200_000,
    }
}

/// 假订阅来源：按顺序返回作品，记下下载过哪些地址；`fail` 里的地址下载时返回对应错误。
#[derive(Default)]
struct FakeSource {
    works: Vec<Work>,
    images: HashMap<String, Vec<u8>>,
    fail: HashMap<String, SourceError>,
    downloads: Vec<String>,
}

impl FakeSource {
    fn with(works: Vec<Work>) -> FakeSource {
        let mut images = HashMap::new();
        let mut seed = 0u8;
        for w in &works {
            for url in &w.pages {
                seed += 1;
                images.insert(url.clone(), png(seed));
            }
        }
        FakeSource {
            works,
            images,
            ..FakeSource::default()
        }
    }
}

impl Source for FakeSource {
    fn id(&self) -> SourceId {
        SourceId::Pixiv
    }

    fn works(
        &mut self,
        _: &Subscription,
        known: &mut dyn FnMut(&str) -> bool,
    ) -> Result<Vec<Work>, SourceError> {
        // 从新到旧，碰到收过的就不再往下翻。
        Ok(self
            .works
            .iter()
            .rev()
            .take_while(|w| !known(&w.id))
            .cloned()
            .collect())
    }

    fn download(&mut self, url: &str) -> Result<Vec<u8>, SourceError> {
        self.downloads.push(url.to_owned());
        if let Some(error) = self.fail.get(url) {
            return Err(error.clone());
        }
        Ok(self.images[url].clone())
    }
}

struct Libraries(Vec<Library>);

impl Destination for Libraries {
    fn import(
        &self,
        library_id: &str,
        page: SubscriptionPage,
        bytes: &[u8],
    ) -> Result<String, String> {
        let library = self
            .0
            .iter()
            .find(|l| l.info().id == library_id)
            .ok_or("没有这个资料库")?;
        library
            .import_from_subscription(page, bytes)
            .map_err(|e| e.to_string())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    libraries: Libraries,
    subscription: Subscription,
    clock: RefCell<i64>,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::create(&dir.path().join("lib"), "库").unwrap();
        library.set_safe_mode(false);
        let store = Store::open(&dir.path().join("device")).unwrap();
        let subscription = store
            .add(
                NewSubscription {
                    target: Target::PixivArtist {
                        user_id: "42".into(),
                    },
                    name: "某画师".into(),
                    library_id: library.info().id.clone(),
                    include_explicit: true,
                    include_manga: false,
                },
                0,
            )
            .unwrap();
        Fixture {
            _dir: dir,
            store,
            libraries: Libraries(vec![library]),
            subscription,
            clock: RefCell::new(1_000),
        }
    }

    fn library(&self) -> &Library {
        &self.libraries.0[0]
    }

    fn check(&self, source: &mut dyn Source) -> Result<CheckReport, SourceError> {
        let now = || {
            let mut t = self.clock.borrow_mut();
            *t += 1;
            *t
        };
        check(
            &self.store,
            &self.subscription,
            source,
            &self.libraries,
            &now,
            &AtomicBool::new(false),
        )
    }
}

#[test]
fn collected_pages_carry_author_source_link_tags_and_explicit_rating() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![work("100", WorkKind::Illustration, true, 2)]);
    let report = f.check(&mut source).unwrap();
    assert_eq!(report.collected, 2);

    let recent = f.store.recent(10).unwrap();
    assert_eq!(recent.len(), 2);
    assert!(recent.iter().all(|r| r.explicit && r.new));
    for received in &recent {
        let detail = f.library().image(&received.image_id).unwrap();
        assert_eq!(detail.source_links, ["https://www.pixiv.net/artworks/100"]);
        assert_eq!(detail.rating.effective, Some(ContentRating::Explicit));
        assert_eq!(detail.collected_at, 1_709_251_200_000);
        let tags = f.library().image_tags(&received.image_id, "zh-CN").unwrap();
        let names: Vec<_> = tags
            .tags
            .iter()
            .map(|t| (t.tag.namespace, t.tag.name.as_str()))
            .collect();
        assert!(
            names.contains(&(TagNamespace::Artist, "某画师")),
            "{names:?}"
        );
        assert!(
            names.contains(&(TagNamespace::General, "オリジナル")),
            "{names:?}"
        );
    }
    // 两页在订阅页按页计为新图；安全模式下不计成人作品；看过后清零。
    assert_eq!(f.store.new_count(true).unwrap(), 2);
    assert_eq!(f.store.new_count(false).unwrap(), 0);
    f.store.mark_seen().unwrap();
    assert_eq!(f.store.new_count(true).unwrap(), 0);
}

#[test]
fn deleted_images_are_not_downloaded_again() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![
        work("1", WorkKind::Illustration, false, 1),
        work("2", WorkKind::Illustration, false, 1),
    ]);
    f.check(&mut source).unwrap();
    assert_eq!(source.downloads.len(), 2);

    // 画师删掉其中一张（进回收站再清空也一样：记录在订阅这边）。
    let deleted = f.store.recent(10).unwrap()[0].image_id.clone();
    f.library().edit(&[deleted], &[ImageEdit::Delete]).unwrap();

    // 来源又列出全部作品（不靠“碰到收过的就停”），下一次检查一张都不下。
    let mut again = FakeSource::with(source.works.clone());
    let report = f.check(&mut FakeSourceIgnoringKnown(&mut again)).unwrap();
    assert_eq!(report.collected, 0);
    assert!(again.downloads.is_empty(), "{:?}", again.downloads);

    // 删掉订阅后重新订阅也不会下回来：记录按资料库保留。
    f.store.remove(&f.subscription.id).unwrap();
    assert!(f.store.list().unwrap().is_empty());
}

/// 不管 `known`、每次都列出全部作品的来源。
struct FakeSourceIgnoringKnown<'a>(&'a mut FakeSource);

impl Source for FakeSourceIgnoringKnown<'_> {
    fn id(&self) -> SourceId {
        SourceId::Pixiv
    }
    fn works(
        &mut self,
        _: &Subscription,
        _: &mut dyn FnMut(&str) -> bool,
    ) -> Result<Vec<Work>, SourceError> {
        Ok(self.0.works.iter().rev().cloned().collect())
    }
    fn download(&mut self, url: &str) -> Result<Vec<u8>, SourceError> {
        self.0.download(url)
    }
}

#[test]
fn animations_are_skipped_and_filtered_kinds_wait() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![
        work("1", WorkKind::Animation, false, 0),
        work("2", WorkKind::Manga, false, 1),
        work("3", WorkKind::Illustration, false, 1),
    ]);
    let report = f.check(&mut source).unwrap();
    assert_eq!((report.collected, report.skipped), (1, 1));
    // 漫画没打开时不收，也不记下：以后在订阅里打开漫画还能收。
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/3_p0.png"]
    );
    assert_eq!(f.store.new_count(true).unwrap(), 1);
}

#[test]
fn rate_limit_stops_the_check_and_keeps_it_due() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![
        work("1", WorkKind::Illustration, false, 2),
        work("2", WorkKind::Illustration, false, 1),
    ]);
    source.fail.insert(
        "https://i.pximg.net/img-original/1_p1.png".into(),
        SourceError::RateLimited,
    );
    assert_eq!(f.check(&mut source), Err(SourceError::RateLimited));
    assert_eq!(source.downloads.len(), 2, "限流后不再下后面的作品");

    let saved = f.store.get(&f.subscription.id).unwrap();
    assert_eq!(saved.last_checked_at, None, "没完成的检查不算检查过");
    assert_eq!(saved.last_error, Some(SourceError::RateLimited));

    // 退避结束后补上：只下第一页之外没收的页。
    source.fail.clear();
    source.downloads.clear();
    let report = f.check(&mut source).unwrap();
    assert_eq!(report.collected, 2);
    assert_eq!(
        source.downloads,
        [
            "https://i.pximg.net/img-original/1_p1.png",
            "https://i.pximg.net/img-original/2_p0.png"
        ]
    );
    let saved = f.store.get(&f.subscription.id).unwrap();
    assert!(saved.last_checked_at.is_some());
    assert_eq!(saved.last_error, None);
}

#[test]
fn a_failed_download_only_skips_that_work_until_next_time() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![
        work("1", WorkKind::Illustration, false, 1),
        work("2", WorkKind::Illustration, false, 1),
    ]);
    source.fail.insert(
        "https://i.pximg.net/img-original/1_p0.png".into(),
        SourceError::Status { status: 404 },
    );
    let report = f.check(&mut source).unwrap();
    assert_eq!((report.collected, report.failed), (1, 1));
    // 来源照常在已收的作品 2 处停止翻页；有待重试的作品 1 时仍要翻到它。
    source.fail.clear();
    source.downloads.clear();
    assert_eq!(f.check(&mut source).unwrap().collected, 1);
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/1_p0.png"]
    );
    // 收成后恢复正常：下一次碰到收过的就停，什么都不下。
    source.downloads.clear();
    assert_eq!(f.check(&mut source).unwrap().collected, 0);
    assert!(source.downloads.is_empty());
}

#[test]
fn checks_resume_after_restart_and_back_off_on_rate_limits() {
    let dir = tempfile::tempdir().unwrap();
    let hour = 60 * 60 * 1000;
    let new = |target| NewSubscription {
        target,
        name: "x".into(),
        library_id: "lib".into(),
        include_explicit: true,
        include_manga: false,
    };
    let (artist, ranking) = {
        let store = Store::open(dir.path()).unwrap();
        let artist = store
            .add(
                new(Target::PixivArtist {
                    user_id: "1".into(),
                }),
                0,
            )
            .unwrap();
        let ranking = store
            .add(
                new(Target::PixivRanking {
                    period: kinshoko_core::subscription::RankingPeriod::Day,
                    top: 50,
                }),
                0,
            )
            .unwrap();
        // 新订阅马上到期；检查过后，画师 6 小时、榜单一天内不再到期。
        let subs = store.list().unwrap();
        assert_eq!(schedule::due(&subs, 0, |_| false).len(), 2);
        store.mark_checked(&artist.id, 0).unwrap();
        store.mark_checked(&ranking.id, 0).unwrap();
        let subs = store.list().unwrap();
        assert!(schedule::due(&subs, 5 * hour, |_| false).is_empty());
        assert_eq!(schedule::next_due(&subs, 5 * hour), Some(6 * hour));
        (artist.id, ranking.id)
    };

    // Kinshoko 关了两天：重新打开后两条都补查一次（不是补四轮）。
    let store = Store::open(dir.path()).unwrap();
    let subs = store.list().unwrap();
    let due: Vec<_> = schedule::due(&subs, 48 * hour, |_| false)
        .into_iter()
        .map(|s| s.id.clone())
        .collect();
    assert_eq!(due.len(), 2);
    assert!(due.contains(&artist) && due.contains(&ranking));

    // 来源在退避中时一条都不查。
    store.set_backoff(SourceId::Pixiv, 49 * hour, 0).unwrap();
    let (until, _) = store.backoff(SourceId::Pixiv).unwrap().unwrap();
    assert!(schedule::due(&subs, 48 * hour, |_| 48 * hour < until).is_empty());
    assert_eq!(schedule::backoff_ms(0), hour / 4);
    assert_eq!(schedule::backoff_ms(1), hour / 2);
    assert_eq!(schedule::backoff_ms(30), 24 * hour);
}

#[test]
fn another_subscriptions_works_do_not_cut_this_listing_short() {
    let f = Fixture::new();
    let works = vec![
        work("1", WorkKind::Illustration, false, 1),
        work("2", WorkKind::Illustration, false, 1),
    ];
    // 另一条订阅先把较新的作品 2 收进了同一个资料库。
    let other = f
        .store
        .add(
            NewSubscription {
                target: Target::PixivBookmarks,
                name: "收藏夹".into(),
                library_id: f.library().info().id.clone(),
                include_explicit: true,
                include_manga: false,
            },
            0,
        )
        .unwrap();
    let mut first = FakeSource::with(vec![works[1].clone()]);
    check(
        &f.store,
        &other,
        &mut first,
        &f.libraries,
        &|| 1,
        &AtomicBool::new(false),
    )
    .unwrap();

    // 这条订阅照样翻过作品 2 收到作品 1，作品 2 不重复下载。
    let mut source = FakeSource::with(works);
    let report = f.check(&mut source).unwrap();
    assert_eq!(report.collected, 1);
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/1_p0.png"]
    );
}

#[test]
fn a_failing_check_waits_before_retrying_and_a_failing_work_is_given_up() {
    let f = Fixture::new();
    // 检查没完成：30 分钟内不再到期，过后再到期。
    let mut source = FakeSource::with(vec![work("1", WorkKind::Illustration, false, 1)]);
    source.fail.insert(
        "https://i.pximg.net/img-original/1_p0.png".into(),
        SourceError::Network,
    );
    assert_eq!(f.check(&mut source), Err(SourceError::Network));
    let subs = f.store.list().unwrap();
    let failed_at = subs[0].last_failed_at.unwrap();
    assert!(schedule::due(&subs, failed_at + 1, |_| false).is_empty());
    assert_eq!(
        schedule::next_due(&subs, failed_at + 1),
        Some(failed_at + schedule::RETRY_MS)
    );
    assert_eq!(
        schedule::due(&subs, failed_at + schedule::RETRY_MS, |_| false).len(),
        1
    );

    // 单个作品一直失败：第 5 次后不再下载它。
    source.fail.insert(
        "https://i.pximg.net/img-original/1_p0.png".into(),
        SourceError::Status { status: 404 },
    );
    for _ in 0..5 {
        f.check(&mut source).unwrap();
    }
    source.downloads.clear();
    assert_eq!(f.check(&mut source).unwrap().failed, 0);
    assert!(source.downloads.is_empty());
}
