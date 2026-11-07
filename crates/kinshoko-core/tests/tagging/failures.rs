//! 子进程崩溃与打不上标的图（#475）：崩溃后重启会话；无法解码、反复崩溃的图计入状态，
//! 崩溃导致的下次启动时重试一次，画师可以手动重试。

use super::*;
use kinshoko_core::library::FailedTagging;

fn failed(unreadable: u32, crashed: u32) -> FailedTagging {
    FailedTagging {
        unreadable,
        crashed,
    }
}

/// 空闲时打不上标的图。
fn failures(status: &TaggingStatus) -> Option<FailedTagging> {
    match status {
        TaggingStatus::Idle { failed, .. } => Some(*failed),
        _ => None,
    }
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
fn images_that_cannot_be_tagged_are_counted_and_crashes_are_retried_on_the_next_start() {
    let f = Fixture::new(3);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.crash_on(&f.original(1), u32::MAX);
    f.fake.bad_image(&f.original(2), "无法解码");
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    let status = idle(&tagging);

    let tagged: Vec<_> = f.fake.tagged().into_iter().map(|t| t.0).collect();
    assert_eq!(tagged, vec![f.original(0)], "其余的图照常打完");
    assert_eq!(
        failures(&status),
        Some(failed(1, 1)),
        "两张没打上标的图分两类计数，不算打完"
    );

    // 下次启动：崩溃导致的那张重试一次（这次不再崩溃就能打上），无法解码的不重试。
    drop(tagging);
    f.fake.crash_on(&f.original(1), 0);
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    let status = idle(&tagging);
    let tagged: Vec<_> = f.fake.tagged().into_iter().map(|t| t.0).collect();
    assert_eq!(tagged, vec![f.original(0), f.original(1)]);
    assert_eq!(failures(&status), Some(failed(1, 0)));
}

#[test]
fn an_image_that_still_crashes_after_the_restart_is_recorded_again_and_not_retried_in_a_loop() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.crash_on(&f.original(0), u32::MAX);
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    idle(&tagging);
    drop(tagging);

    let before = f.fake.started().len();
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    let status = idle(&tagging);
    assert_eq!(failures(&status), Some(failed(0, 1)));
    let restarted = f.fake.started().len() - before;
    assert_eq!(restarted, 2, "重试的这一轮仍按崩溃次数上限放弃");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        f.fake.started().len() - before,
        restarted,
        "同一次运行里不再重试"
    );
}

#[test]
fn retrying_failed_images_tags_them_again_once() {
    let f = Fixture::new(2);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.crash_on(&f.original(0), 2);
    f.fake.bad_image(&f.original(1), "无法解码");
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    assert_eq!(failures(&idle(&tagging)), Some(failed(1, 1)));

    f.fake.fix_image(&f.original(1));
    tagging.retry_failed();
    let status = wait_for(&tagging, "重试完成", |s| {
        failures(s) == Some(failed(0, 0))
    });
    let mut tagged: Vec<_> = f.fake.tagged().into_iter().map(|t| t.0).collect();
    tagged.sort();
    let mut expected = vec![f.original(0), f.original(1)];
    expected.sort();
    assert_eq!(tagged, expected, "{status:?}");
}

#[test]
fn retrying_an_image_that_still_cannot_be_decoded_records_it_again() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.bad_image(&f.original(0), "无法解码");
    let spec = f.server.publish("gpu", Device::DirectMl, b"model");
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    assert_eq!(failures(&idle(&tagging)), Some(failed(1, 0)));

    tagging.retry_failed();
    // 重试后先离开 Idle（或直接又记为失败）；等它再次稳定。
    std::thread::sleep(Duration::from_millis(100));
    let status = idle(&tagging);
    assert_eq!(failures(&status), Some(failed(1, 0)));
    assert!(f.fake.tagged().is_empty());
}
