//! 模型下载：续传、暂停与取消（#213）、校验失败与出错原因。

use super::*;

#[test]
fn an_interrupted_download_resumes_where_it_stopped() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let model = vec![7u8; 300_000];
    let spec = f.server.publish("gpu", Device::DirectMl, &model);
    let path = support::model_path(&spec, &spec.file);
    f.server.cut_next(&path, 100_000);
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    let failed = wait_for(&tagging, "下载中断", |s| {
        matches!(s, TaggingStatus::Failed { .. })
    });
    assert!(matches!(failed, TaggingStatus::Failed { .. }));
    idle(&tagging);

    assert_eq!(
        ranges(&f, &path),
        vec![None, Some(100_000)],
        "第二次从断点续传"
    );
}

#[test]
fn a_partial_download_is_shown_before_the_artist_confirms() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let model = vec![7u8; 300_000];
    let spec = f.server.publish("gpu", Device::DirectMl, &model);
    f.server
        .cut_next(&support::model_path(&spec, &spec.file), 120_000);
    let tagging = f.start(f.config(vec![spec.clone()]));
    tagging.download();
    wait_for(&tagging, "下载中断", |s| {
        matches!(s, TaggingStatus::Failed { .. })
    });
    drop(tagging);

    // 重新启动（例如应用重开）：先显示已下的部分，等画师确认。
    let tagging = f.start(f.config(vec![spec]));
    let status = wait_for(&tagging, "需要下载模型", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert_eq!(
        status,
        TaggingStatus::NeedsDownload {
            model: "测试模型 gpu".into(),
            size: 300_000,
            downloaded: 120_000,
            fallback: None,
            cancelled: false,
        }
    );
}

/// 测试服务收到的对 `path` 的请求的 Range 起点。
fn ranges(f: &Fixture, path: &str) -> Vec<Option<u64>> {
    f.server
        .requests()
        .into_iter()
        .filter(|(p, _)| p == path)
        .map(|(_, range)| range)
        .collect()
}

/// 下载中暂停（#213）：停下并保留已下的部分，继续时从断点续传。
#[test]
fn pausing_a_download_keeps_what_was_downloaded_and_resuming_continues_from_it() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let spec = f.server.publish("gpu", Device::DirectMl, &[7u8; 300_000]);
    let path = support::model_path(&spec, &spec.file);
    f.server.stall_next(&path, 100_000);
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    wait_for(&tagging, "开始下载", |s| {
        matches!(s, TaggingStatus::Downloading { .. })
    });
    tagging.pause();
    f.server.release();
    wait_for(&tagging, "暂停", |s| *s == TaggingStatus::Paused);
    tagging.resume();
    idle(&tagging);

    let ranges = ranges(&f, &path);
    assert!(
        matches!(ranges[..], [None, Some(n)] if n > 0 && n < 300_000),
        "暂停时停下，继续时从断点续传：{ranges:?}"
    );
}

/// 下载中取消（#213）：回到需要下载并写出已下的部分，不自己重新开始；再确认下载时从断点续传。
#[test]
fn cancelling_a_download_asks_again_and_downloading_again_resumes() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let spec = f.server.publish("gpu", Device::DirectMl, &[7u8; 300_000]);
    let path = support::model_path(&spec, &spec.file);
    f.server.stall_next(&path, 100_000);
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    wait_for(&tagging, "开始下载", |s| {
        matches!(s, TaggingStatus::Downloading { .. })
    });
    tagging.cancel_download();
    f.server.release();
    let TaggingStatus::NeedsDownload {
        downloaded,
        cancelled: true,
        ..
    } = wait_for(&tagging, "回到需要下载", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    })
    else {
        unreachable!()
    };
    assert!(downloaded > 0 && downloaded < 300_000, "{downloaded}");
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        matches!(tagging.status(), TaggingStatus::NeedsDownload { .. }),
        "取消后等画师再确认：{:?}",
        tagging.status()
    );

    tagging.download();
    idle(&tagging);
    assert_eq!(ranges(&f, &path), vec![None, Some(downloaded)]);
}

#[test]
fn a_model_with_the_wrong_hash_is_deleted_and_never_used() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let mut spec = f.server.publish("gpu", Device::DirectMl, b"model");
    // 服务器上的文件被换掉了。
    f.server
        .put(&support::model_path(&spec, &spec.file), b"MODEL");
    spec.size = 5;
    let tagging = f.start(f.config(vec![spec]));
    tagging.download();
    let status = wait_for(&tagging, "校验失败", |s| {
        matches!(s, TaggingStatus::Failed { .. })
    });
    let TaggingStatus::Failed { reason } = status else {
        unreachable!()
    };
    assert!(reason.contains("校验失败"), "{reason}");
    drop(tagging);
    assert!(f.fake.started().is_empty(), "没有用未通过校验的模型");
    assert!(
        !f.dir.path().join("models/gpu/model.onnx").exists(),
        "已删除"
    );
}

#[test]
fn a_failed_download_says_why_without_the_download_address() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    // 没有发布到测试服务的模型：服务返回 404。
    let missing = support::test_spec("missing-fp16", Device::DirectMl, b"never published");
    let tagging = f.start(f.config(vec![missing]));
    tagging.download();
    let TaggingStatus::Failed { reason } = wait_for(&tagging, "下载失败", |s| {
        matches!(s, TaggingStatus::Failed { .. })
    }) else {
        unreachable!()
    };
    assert!(reason.contains("404"), "{reason}");
    assert!(
        !reason.contains("missing-fp16") && !reason.contains("http"),
        "原因里不出现下载地址（含精度字样的仓库与文件名）：{reason}"
    );
}
