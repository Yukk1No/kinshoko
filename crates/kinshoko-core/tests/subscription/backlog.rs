//! 订阅画师（#369）：只收新作不下旧作，最近 N 张只下 N 张，之后全部列出也不补旧作。

use super::*;

/// 发布于 `day` 那天（从 2024-03-01 起算）的作品。
fn posted(mut work: Work, day: i64) -> Work {
    work.posted_at = 1_709_251_200_000 + day * 86_400_000;
    work
}

#[test]
fn new_only_collects_nothing_posted_before_subscribing() {
    let subscribed_at = 1_709_251_200_000 + 10 * 86_400_000;
    let f = Fixture::with(Backlog::NewOnly, subscribed_at);
    let mut source = FakeSource::with(vec![
        posted(work("1", WorkKind::Illustration, false, 2), 1),
        posted(work("2", WorkKind::Illustration, false, 1), 5),
    ]);
    let report = f.check(&mut source).unwrap();
    assert_eq!(report.collected, 0);
    assert!(source.downloads.is_empty(), "{:?}", source.downloads);
    // 碰到第一个旧作就不再往下翻。
    assert_eq!(source.listed, 1);

    // 订阅以后发的作品照收；全部列出时旧作仍一张不下。
    source
        .works
        .push(posted(work("3", WorkKind::Illustration, false, 1), 11));
    let mut again = FakeSource::with(source.works.clone());
    let report = f.check(&mut FakeSourceIgnoringKnown(&mut again)).unwrap();
    assert_eq!(report.collected, 1);
    assert_eq!(
        again.downloads,
        ["https://i.pximg.net/img-original/3_p0.png"]
    );
}

#[test]
fn recent_count_collects_exactly_that_many_images() {
    let f = Fixture::with(Backlog::Recent { count: 4 }, 0);
    let works = vec![
        posted(work("1", WorkKind::Illustration, false, 1), 1),
        posted(work("2", WorkKind::Illustration, false, 3), 2),
        posted(work("3", WorkKind::Animation, false, 0), 3),
        posted(work("4", WorkKind::Manga, false, 2), 4),
        posted(work("5", WorkKind::Illustration, false, 2), 5),
    ];
    let mut source = FakeSource::with(works.clone());
    let report = f.check(&mut source).unwrap();
    // 从新到旧：作品 5 两张、作品 2 前两张，共四张；漫画没打开不算，动图记为已跳过。
    assert_eq!((report.collected, report.skipped), (4, 1));
    assert_eq!(
        source.downloads,
        [
            "https://i.pximg.net/img-original/2_p0.png",
            "https://i.pximg.net/img-original/2_p1.png",
            "https://i.pximg.net/img-original/5_p0.png",
            "https://i.pximg.net/img-original/5_p1.png",
        ]
    );
    assert_eq!(f.store.get(&f.subscription.id).unwrap().skipped, 1);

    // 之后全部列出也不补旧作，也不补作品 2 剩下的页；新作照收。
    let mut works = works;
    works.push(posted(work("6", WorkKind::Illustration, false, 1), 6));
    let mut again = FakeSource::with(works);
    let report = f.check(&mut FakeSourceIgnoringKnown(&mut again)).unwrap();
    assert_eq!(report.collected, 1);
    assert_eq!(
        again.downloads,
        ["https://i.pximg.net/img-original/6_p0.png"]
    );
}

#[test]
fn recent_count_larger_than_the_backlog_collects_everything() {
    let f = Fixture::with(Backlog::Recent { count: 50 }, 0);
    let mut source = FakeSource::with(vec![
        posted(work("1", WorkKind::Illustration, false, 2), 1),
        posted(work("2", WorkKind::Illustration, false, 1), 2),
    ]);
    assert_eq!(f.check(&mut source).unwrap().collected, 3);
    assert_eq!(source.listed, 2);
}

#[test]
fn options_can_change_but_unknown_subscriptions_cannot() {
    let f = Fixture::new();
    let changed = f
        .store
        .set_options(&f.subscription.id, false, true)
        .unwrap();
    assert!(!changed.include_explicit && changed.include_manga);
    assert_eq!(changed.library_id, f.subscription.library_id);
    assert!(f.store.set_options("nope", true, true).is_err());
}

#[test]
fn a_failed_boundary_work_is_retried_only_up_to_the_window() {
    let f = Fixture::with(Backlog::Recent { count: 2 }, 0);
    let mut source = FakeSource::with(vec![posted(
        work("1", WorkKind::Illustration, false, 10),
        1,
    )]);
    source.fail.insert(
        "https://i.pximg.net/img-original/1_p1.png".into(),
        SourceError::Status { status: 500 },
    );
    let report = f.check(&mut source).unwrap();
    assert_eq!((report.collected, report.failed), (0, 1));
    // 窗口第一次检查就定下了。
    assert!(f.store.get(&f.subscription.id).unwrap().since.is_some());

    // 重试前画师又发了两张：新作照收，没收完的作品 1 也补上，且只补到窗口里的第二页。
    source
        .works
        .push(posted(work("2", WorkKind::Illustration, false, 2), 2));
    let mut again = FakeSource::with(source.works.clone());
    f.check(&mut again).unwrap();
    assert_eq!(
        again.downloads,
        [
            "https://i.pximg.net/img-original/1_p1.png",
            "https://i.pximg.net/img-original/2_p0.png",
            "https://i.pximg.net/img-original/2_p1.png",
        ]
    );
}

/// 收进第一张图后把订阅退订掉的资料库。
struct UnsubscribeAfterFirst<'a>(&'a Fixture);

impl Destination for UnsubscribeAfterFirst<'_> {
    fn import(
        &self,
        library_id: &str,
        page: SubscriptionPage,
        bytes: &[u8],
    ) -> Result<String, String> {
        let id = self.0.libraries.import(library_id, page, bytes)?;
        let _ = self.0.store.remove(&self.0.subscription.id);
        Ok(id)
    }
}

#[test]
fn unsubscribing_during_a_check_stops_it() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![
        posted(work("1", WorkKind::Illustration, false, 1), 1),
        posted(work("2", WorkKind::Illustration, false, 1), 2),
    ]);
    let result = check(
        &f.store,
        &f.subscription,
        &mut source,
        &UnsubscribeAfterFirst(&f),
        &|| 5_000,
        &AtomicBool::new(false),
    );
    assert_eq!(result.unwrap_err(), SourceError::Cancelled);
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/1_p0.png"]
    );
}

#[test]
fn works_posted_at_the_cutoff_but_left_out_stay_out() {
    let f = Fixture::with(Backlog::Recent { count: 1 }, 0);
    // 两个作品同一时刻发布：只数进较新列出的那个。
    let works = vec![
        posted(work("3", WorkKind::Illustration, false, 1), 0),
        posted(work("1", WorkKind::Illustration, false, 1), 1),
        posted(work("2", WorkKind::Illustration, false, 1), 1),
    ];
    let mut source = FakeSource::with(works.clone());
    assert_eq!(f.check(&mut source).unwrap().collected, 1);
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/2_p0.png"]
    );

    // 之后全部列出也不补同一时刻的作品 1。
    let mut again = FakeSource::with(works);
    assert_eq!(
        f.check(&mut FakeSourceIgnoringKnown(&mut again))
            .unwrap()
            .collected,
        0
    );
    assert!(again.downloads.is_empty(), "{:?}", again.downloads);
}

#[test]
fn unsubscribing_between_pages_stops_the_work() {
    let f = Fixture::new();
    let mut source = FakeSource::with(vec![posted(work("1", WorkKind::Illustration, false, 5), 1)]);
    let result = check(
        &f.store,
        &f.subscription,
        &mut source,
        &UnsubscribeAfterFirst(&f),
        &|| 5_000,
        &AtomicBool::new(false),
    );
    assert_eq!(result.unwrap_err(), SourceError::Cancelled);
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/1_p0.png"]
    );
}

#[test]
fn animations_after_the_recent_window_stop_the_listing() {
    // 插画流里数够一张以后，后面更早的动图也让列表停下，不必翻完一堆动图。
    let f = Fixture::with(Backlog::Recent { count: 1 }, 0);
    let mut source = FakeSource::with(vec![
        posted(work("1", WorkKind::Illustration, false, 1), 1),
        posted(work("2", WorkKind::Animation, false, 1), 2),
        posted(work("3", WorkKind::Animation, false, 1), 3),
        posted(work("4", WorkKind::Illustration, false, 1), 4),
    ]);
    assert_eq!(f.check(&mut source).unwrap().collected, 1);
    assert_eq!(source.listed, 2);
    assert_eq!(
        source.downloads,
        ["https://i.pximg.net/img-original/4_p0.png"]
    );
}
