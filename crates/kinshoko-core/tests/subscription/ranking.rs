//! 订阅榜单（#370）：同一作品同时在日榜和周榜只收一次，别的订阅收过的也不再收；榜单不看发布时间；
//! 新装时没有任何榜单订阅。

use super::*;
use kinshoko_core::subscription::RankingPeriod;

fn ranking(f: &Fixture, period: RankingPeriod, top: u32) -> Subscription {
    f.store
        .add(
            NewSubscription {
                target: Target::PixivRanking {
                    period,
                    top,
                    explicit: false,
                },
                name: format!("{period:?} {top}"),
                library_id: f.library().info().id.clone(),
                include_explicit: true,
                include_manga: false,
                // 界面给什么旧作选项都一样：榜单每次收当时榜上的作品。
                backlog: Backlog::NewOnly,
            },
            *f.clock.borrow(),
        )
        .unwrap()
}

fn check_ranking(f: &Fixture, subscription: &Subscription, source: &mut dyn Source) -> CheckReport {
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
    .unwrap()
}

#[test]
fn a_work_on_both_the_daily_and_weekly_ranking_is_collected_once() {
    // 订阅时间晚于作品的发布时间：榜单照样收。
    let f = Fixture::with(Backlog::All, 1_709_251_200_000 + 30 * 86_400_000);
    let day = ranking(&f, RankingPeriod::Day, 10);
    let week = ranking(&f, RankingPeriod::Week, 10);

    let mut daily = FakeSource::with(vec![
        work("2", WorkKind::Illustration, false, 1),
        work("1", WorkKind::Illustration, false, 2),
    ]);
    let report = check_ranking(&f, &day, &mut daily);
    assert_eq!(report.collected, 3);

    // 作品 1 也在周榜上：不再下载，只收周榜独有的作品 3。
    let mut weekly = FakeSource::with(vec![
        work("3", WorkKind::Illustration, false, 1),
        work("1", WorkKind::Illustration, false, 2),
    ]);
    let report = check_ranking(&f, &week, &mut weekly);
    assert_eq!(report.collected, 1);
    assert_eq!(
        weekly.downloads,
        ["https://i.pximg.net/img-original/3_p0.png"]
    );
    let received: Vec<_> = f.store.recent(10).unwrap();
    assert_eq!(received.len(), 4, "图库里每页只有一张");

    // 第二天日榜还有作品 1：同一条订阅也不重复收。
    let mut next_day = FakeSource::with(vec![work("1", WorkKind::Illustration, false, 2)]);
    assert_eq!(check_ranking(&f, &day, &mut next_day).collected, 0);
    assert!(next_day.downloads.is_empty());
}

#[test]
fn works_collected_by_an_artist_subscription_are_not_collected_again() {
    let f = Fixture::new();
    let mut artist = FakeSource::with(vec![work("7", WorkKind::Illustration, false, 1)]);
    assert_eq!(f.check(&mut artist).unwrap().collected, 1);

    let month = ranking(&f, RankingPeriod::Month, 50);
    let mut monthly = FakeSource::with(vec![
        work("8", WorkKind::Illustration, false, 1),
        work("7", WorkKind::Illustration, false, 1),
    ]);
    assert_eq!(check_ranking(&f, &month, &mut monthly).collected, 1);
    assert_eq!(
        monthly.downloads,
        ["https://i.pximg.net/img-original/8_p0.png"]
    );
}

#[test]
fn changing_the_top_keeps_the_ranking_and_what_was_collected() {
    let f = Fixture::new();
    let day = ranking(&f, RankingPeriod::Day, 50);
    let mut daily = FakeSource::with(vec![work("1", WorkKind::Illustration, false, 1)]);
    check_ranking(&f, &day, &mut daily);

    let saved = f.store.set_options(&day.id, true, false, Some(10)).unwrap();
    assert_eq!(
        saved.target,
        Target::PixivRanking {
            period: RankingPeriod::Day,
            top: 10,
            explicit: false
        }
    );
    // 不做自动清理：名次改小，已收的图留着。
    assert_eq!(f.store.recent(10).unwrap().len(), 1);
    // 不是榜单时不管名次。
    let artist = f
        .store
        .set_options(&f.subscription.id, true, false, Some(10))
        .unwrap();
    assert_eq!(artist.target, f.subscription.target);
}

#[test]
fn a_new_install_has_no_ranking_subscriptions() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert!(store.list().unwrap().is_empty());
}

#[test]
fn only_offered_tops_and_existing_rankings_are_valid() {
    let target = |period, top, explicit| Target::PixivRanking {
        period,
        top,
        explicit,
    };
    for top in [10, 50, 100] {
        assert!(target(RankingPeriod::Day, top, false).is_valid());
    }
    assert!(!target(RankingPeriod::Day, 20, false).is_valid());
    assert!(target(RankingPeriod::Week, 10, true).is_valid());
    // pixiv 没有 R-18 月榜。
    assert!(!target(RankingPeriod::Month, 10, true).is_valid());
    // #368 时存下的榜单（还没有 R-18 字段）读得回来，算普通榜单。
    let old: Target =
        serde_json::from_str(r#"{"kind":"pixivRanking","period":"day","top":50}"#).unwrap();
    assert_eq!(old, target(RankingPeriod::Day, 50, false));
}
