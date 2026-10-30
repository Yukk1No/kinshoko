//! 打标调度：按模型来源写入建议与分级、新图随到随打、暂停与崩溃恢复、写入闸门。

use super::*;

#[test]
fn new_images_get_model_suggestions_and_rating_after_the_model_is_downloaded() {
    let f = Fixture::new(2);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.set_output(
        &f.original(0),
        vec![
            raw("blue_eyes", 0, 0.9),
            // 低于一般标签阈值 0.17，不是建议。
            raw("long_hair", 0, 0.1),
            raw("hatsune_miku", 4, 0.95),
            raw("general", 9, 0.2),
            raw("explicit", 9, 0.7),
        ],
    );
    let spec = f
        .server
        .publish("gpu", Device::DirectMl, b"fake onnx model");
    let tagging = f.start(f.config(vec![spec]));

    let status = wait_for(&tagging, "需要下载模型", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    let TaggingStatus::NeedsDownload { size, .. } = status else {
        unreachable!()
    };
    assert_eq!(size, b"fake onnx model".len() as u64);
    assert!(
        tags_of(&f.library, &f.ids[0]).is_empty(),
        "模型就绪前不打标"
    );

    tagging.download();
    let status = idle(&tagging);
    assert!(matches!(
        status,
        TaggingStatus::Idle {
            device: Device::DirectMl,
            ..
        }
    ));

    assert_eq!(
        tags_of(&f.library, &f.ids[0]),
        vec![
            (TagNamespace::General, "blue eyes".into(), model_origin(0.9)),
            (
                TagNamespace::Character,
                "hatsune miku".into(),
                model_origin(0.95)
            ),
        ]
    );
    let rating = f.library.image_rating(&f.ids[0]).unwrap();
    assert_eq!(rating.suggested, Some(ContentRating::Explicit));
    assert_eq!(rating.effective, Some(ContentRating::Explicit));
    // 没有输出的图也算打过，只是没有建议。
    assert!(tags_of(&f.library, &f.ids[1]).is_empty());
    assert_eq!(f.fake.tagged().len(), 2);
}

fn external(name: &str) -> TagRef {
    TagRef::External {
        namespace: TagNamespace::General,
        name: name.into(),
    }
}

#[test]
fn model_suggestions_never_override_manual_tag_decisions() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake
        .set_output(&f.original(0), vec![raw("blue_eyes", 0, 0.9)]);
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    // 画师先否决了 blue_eyes，又手动加了 smile。
    f.library
        .edit_tags(
            &f.ids,
            &[
                TagEdit::Reject {
                    tag: external("blue_eyes"),
                },
                TagEdit::Add {
                    tag: external("smile"),
                },
            ],
        )
        .unwrap();

    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    idle(&tagging);

    let tags = f.library.image_tags(&f.ids[0], ZH).unwrap();
    let names: Vec<_> = tags.tags.iter().map(|t| t.tag.name.as_str()).collect();
    assert_eq!(names, vec!["smile"]);
    assert_eq!(tags.tags[0].origins, vec![TagOrigin::Manual]);
    let rejected: Vec<_> = tags.rejected.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(rejected, vec!["blue eyes"], "模型建议仍被否决");
}

#[test]
fn images_imported_later_are_tagged_without_restarting() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let mut config = f.config(vec![spec]);
    config.poll_interval = Duration::from_secs(60);
    let tagging = f.start(config);
    tagging.download();
    idle(&tagging);
    assert_eq!(f.fake.tagged().len(), 1);
    assert_eq!(f.fake.live_sessions(), 0, "空闲时不占显存");

    let later = f.import(10..11);
    f.fake.set_output(
        &f.library.original_path(&later[0]).unwrap(),
        vec![raw("long_hair", 0, 0.5)],
    );
    tagging.wake();
    wait_for(&tagging, "新图打标", |_| f.fake.tagged().len() == 2);
    idle(&tagging);
    let names: Vec<_> = tags_of(&f.library, &later[0])
        .into_iter()
        .map(|t| t.1)
        .collect();
    assert_eq!(names, vec!["long hair"]);
}

#[test]
fn running_reports_progress_through_the_current_round() {
    let f = Fixture::new(3);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.set_delay(Duration::from_millis(200));
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();

    let status = wait_for(&tagging, "打第二张", |s| {
        matches!(s, TaggingStatus::Running { done: 1, .. })
    });
    let TaggingStatus::Running { remaining, .. } = status else {
        unreachable!()
    };
    assert_eq!(remaining, 2, "含正在打的这张");
    idle(&tagging);

    // 新的一轮从零算起。
    f.import(10..12);
    tagging.wake();
    let status = wait_for(&tagging, "新一轮开始", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });
    let TaggingStatus::Running {
        done, remaining, ..
    } = status
    else {
        unreachable!()
    };
    assert_eq!((done, remaining), (0, 2));
}

#[test]
fn pausing_ends_the_session_and_resuming_continues() {
    let f = Fixture::new(4);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.set_delay(Duration::from_millis(100));
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    wait_for(&tagging, "开始打标", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });

    tagging.pause();
    wait_for(&tagging, "暂停", |s| matches!(s, TaggingStatus::Paused));
    assert_eq!(f.fake.live_sessions(), 0, "暂停后会话结束，显存归还");
    let done = f.fake.tagged().len();
    assert!(done < 4);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(f.fake.tagged().len(), done, "暂停期间不打标");

    tagging.resume();
    idle(&tagging);
    assert_eq!(f.fake.tagged().len(), 4);
}

#[test]
fn pausing_ends_the_session_at_once_without_waiting_for_the_current_image() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    // CPU 档一张约 29 秒：暂停不能等这张打完。
    f.fake.set_delay(Duration::from_secs(30));
    f.fake
        .set_output(&f.original(0), vec![raw("blue_eyes", 0, 0.9)]);
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    wait_for(&tagging, "开始打标", |s| {
        matches!(s, TaggingStatus::Running { .. })
    });
    std::thread::sleep(Duration::from_millis(50));

    let asked = Instant::now();
    tagging.pause();
    wait_for(&tagging, "暂停", |s| matches!(s, TaggingStatus::Paused));
    assert!(asked.elapsed() < Duration::from_secs(2), "立即暂停");
    assert_eq!(f.fake.live_sessions(), 0, "会话已结束，显存已归还");
    assert!(f.fake.tagged().is_empty());

    // 被打断的那张不算出错：恢复后照常打完。
    f.fake.set_delay(Duration::ZERO);
    tagging.resume();
    idle(&tagging);
    let names: Vec<_> = tags_of(&f.library, &f.ids[0])
        .into_iter()
        .map(|t| t.1)
        .collect();
    assert_eq!(names, vec!["blue eyes"]);
}

#[test]
fn a_crashed_session_is_restarted_and_the_image_is_tagged() {
    let f = Fixture::new(2);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.crash_on(&f.original(1), 1);
    f.fake
        .set_output(&f.original(1), vec![raw("blue_eyes", 0, 0.8)]);
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    idle(&tagging);

    assert_eq!(f.fake.started().len(), 2, "崩溃后重启了一次会话");
    assert_eq!(f.fake.live_sessions(), 0);
    let names: Vec<_> = tags_of(&f.library, &f.ids[1])
        .into_iter()
        .map(|t| t.1)
        .collect();
    assert_eq!(names, vec!["blue eyes"]);
}

#[test]
fn an_image_that_keeps_crashing_the_session_is_skipped() {
    let f = Fixture::new(3);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.crash_on(&f.original(1), u32::MAX);
    f.fake.bad_image(&f.original(2), "无法解码");
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    idle(&tagging);

    let tagged: Vec<_> = f.fake.tagged().into_iter().map(|t| t.0).collect();
    assert_eq!(tagged, vec![f.original(0)], "其余的图照常打完");
    // 重新开始也不再试这两张。
    drop(tagging);
    let before = f.fake.started().len();
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    idle(&tagging);
    assert_eq!(f.fake.started().len(), before, "没有待打标的图，不开会话");
}

/// 第一次加载模型时停在“加载中”，等测试放行后才报告就绪（即使会话已被结束开关结束）：
/// 模拟画师在加载中暂停、子进程的 Ready 却迟到的情形（#77 UI-C）。
struct LateReady {
    inner: InMemoryTagger,
    gate: Arc<(std::sync::Mutex<(bool, bool)>, std::sync::Condvar)>,
}

impl kinshoko_core::tagging::Tagger for LateReady {
    fn probe(&self) -> kinshoko_core::tagging::DeviceInfo {
        self.inner.probe()
    }

    fn start(
        &self,
        model: &kinshoko_core::tagging::PreparedModel,
        device: Device,
        on_stopper: &dyn Fn(kinshoko_core::tagging::SessionStopper),
    ) -> Result<Box<dyn kinshoko_core::tagging::TaggerSession>, kinshoko_core::tagging::TagFailure>
    {
        let session = self.inner.start(model, device, on_stopper);
        let (lock, wake) = &*self.gate;
        let mut state = lock.lock().unwrap();
        if !state.1 {
            // (正在加载, 已放行)
            state.0 = true;
            wake.notify_all();
            while !state.1 {
                state = wake.wait(state).unwrap();
            }
        }
        session
    }
}

#[test]
fn a_ready_that_arrives_after_pausing_does_not_restart_tagging() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let gate = Arc::new((
        std::sync::Mutex::new((false, false)),
        std::sync::Condvar::new(),
    ));
    let tagger = LateReady {
        inner: f.fake.clone(),
        gate: gate.clone(),
    };
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = Tagging::start(f.library.clone(), Arc::new(tagger), f.config(vec![spec]));
    tagging.download();
    {
        let (lock, wake) = &*gate;
        let mut state = lock.lock().unwrap();
        while !state.0 {
            state = wake.wait(state).unwrap();
        }
    }
    // 刚下载完时加载中仍显示“校验模型”，否则为“开始”：两者界面上都有暂停（#77 UI-C）。
    let loading = tagging.status();

    tagging.pause();
    let release = || {
        let (lock, wake) = &*gate;
        lock.lock().unwrap().1 = true;
        wake.notify_all();
    };
    release();
    assert!(
        matches!(
            loading,
            TaggingStatus::Starting | TaggingStatus::Preparing { .. }
        ),
        "加载中：{loading:?}"
    );
    wait_for(&tagging, "暂停", |s| matches!(s, TaggingStatus::Paused));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        tagging.status(),
        TaggingStatus::Paused,
        "迟到的就绪不重新开始打标"
    );
    assert!(f.fake.tagged().is_empty(), "暂停后没有打标");
    assert_eq!(f.fake.live_sessions(), 0, "迟到就绪的会话已结束");

    tagging.resume();
    idle(&tagging);
    assert_eq!(f.fake.tagged().len(), 1, "恢复后照常打标");
}

#[test]
fn inference_runs_outside_the_publication_gate_and_rating_commits_after_release() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.set_output(
        &f.original(0),
        vec![raw("blue_eyes", 0, 0.9), raw("explicit", 9, 0.9)],
    );
    let spec = f
        .server
        .publish("gpu", Device::DirectMl, b"publication gate model");
    let gate = Arc::new(std::sync::Mutex::new(()));
    let mut config = f.config(vec![spec]);
    config.publication_gate = Some(gate.clone());
    let tagging = f.start(config);
    let held = gate.lock().unwrap();
    tagging.download();
    let deadline = Instant::now() + Duration::from_secs(10);
    while f.fake.tagged().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let inference_completed = !f.fake.tagged().is_empty();
    // A completed in-memory inference would publish immediately without the boundary.
    std::thread::sleep(Duration::from_millis(60));
    let rating_while_held = f.library.image_rating(&f.ids[0]).unwrap().suggested;
    let tags_while_held = tags_of(&f.library, &f.ids[0]);
    // Release before asserting or dropping Tagging: Drop joins the scheduler worker.
    drop(held);
    idle(&tagging);
    assert!(
        inference_completed,
        "inference must run while the publication gate is held"
    );
    assert_eq!(
        rating_while_held, None,
        "automatic rating must not cross an active final commit"
    );
    assert!(
        tags_while_held.is_empty(),
        "one result's tags and rating share its publication boundary"
    );
    assert_eq!(
        f.library.image_rating(&f.ids[0]).unwrap().suggested,
        Some(ContentRating::Explicit)
    );
}

#[test]
fn pausing_discards_inference_waiting_for_publication_then_resume_can_retag() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake
        .set_output(&f.original(0), vec![raw("explicit", 9, 0.9)]);
    let spec = f
        .server
        .publish("gpu", Device::DirectMl, b"pause before publication model");
    let gate = Arc::new(std::sync::Mutex::new(()));
    let mut config = f.config(vec![spec]);
    config.publication_gate = Some(gate.clone());
    let tagging = f.start(config);
    let held = gate.lock().unwrap();
    tagging.download();
    let deadline = Instant::now() + Duration::from_secs(10);
    while f.fake.tagged().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let completed = !f.fake.tagged().is_empty();
    tagging.pause(); // Does not wait for the gate or join its worker.
    drop(held); // A detach/drop caller must also release the gate before joining.
    wait_for(&tagging, "paused publication", |status| {
        matches!(status, TaggingStatus::Paused)
    });
    assert!(completed, "inference completed before pause");
    assert_eq!(f.library.image_rating(&f.ids[0]).unwrap().suggested, None);
    assert!(tags_of(&f.library, &f.ids[0]).is_empty());
    tagging.resume();
    idle(&tagging);
    assert_eq!(
        f.library.image_rating(&f.ids[0]).unwrap().suggested,
        Some(ContentRating::Explicit)
    );
}

/// 界面在一轮打完时提示“新打了 N 张”（#144）：Running 在打每张之前推送，
/// 最后一张只能由随后的 Idle 带出；Idle 带本次运行打过的累计张数，界面按差值算这一轮。
#[test]
fn idle_reports_how_many_images_this_run_has_tagged() {
    let f = Fixture::new(2);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let spec = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let mut config = f.config(vec![spec]);
    config.poll_interval = Duration::from_millis(20);
    let tagging = f.start(config);
    tagging.download();

    assert!(
        matches!(idle(&tagging), TaggingStatus::Idle { tagged: 2, .. }),
        "两张都打完"
    );

    f.import(10..11);
    tagging.wake();
    wait_for(&tagging, "新图打完后累计三张", |s| {
        matches!(s, TaggingStatus::Idle { tagged: 3, .. })
    });
}
