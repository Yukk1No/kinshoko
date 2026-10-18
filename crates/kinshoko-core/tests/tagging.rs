//! 自动标签（#52）：模型下载与校验、打标调度、按模型来源写入建议与分级、子进程崩溃后恢复。
//! 资料库用临时目录里的真库；打标子进程用内存假实现，模型从本地测试服务下载。

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    ContentRating, ImageTags, ImportOutcome, ImportSource, TagEdit, TagNamespace, TagOrigin, TagRef,
};
use kinshoko_core::tagging::{
    Device, HardwareOption, InMemoryTagger, ModelChoice, ModelStore, RawTag, Tagging,
    TaggingConfig, TaggingStatus,
};
use std::sync::atomic::AtomicBool;
use support::ModelServer;

const ZH: &str = "zh-CN";
const GPU_BUDGET: u64 = 4_000_000_000;

struct Fixture {
    dir: tempfile::TempDir,
    library: Arc<Library>,
    ids: Vec<String>,
    server: ModelServer,
    fake: InMemoryTagger,
}

impl Fixture {
    fn new(images: u8) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let library = Arc::new(Library::create(&dir.path().join("lib"), "库").unwrap());
        // 这里只看打标结果；安全模式（#60）另有测试，关掉它以便读到成人分级的图。
        library.set_safe_mode(false);
        let fixture = Fixture {
            library,
            ids: Vec::new(),
            server: ModelServer::start(),
            fake: InMemoryTagger::new(),
            dir,
        };
        let mut fixture = fixture;
        fixture.ids = fixture.import(0..images);
        fixture
    }

    fn import(&self, seeds: impl Iterator<Item = u8>) -> Vec<String> {
        let paths: Vec<PathBuf> = seeds
            .map(|i| {
                let path = self.dir.path().join(format!("in/{i}.png"));
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                RgbaImage::from_fn(4, 4, |x, y| image::Rgba([i, x as u8, y as u8, 255]))
                    .save(&path)
                    .unwrap();
                path
            })
            .collect();
        self.library
            .import(ImportSource { paths })
            .wait()
            .items
            .into_iter()
            .map(|item| match item.outcome {
                ImportOutcome::Imported { image_id } => image_id,
                other => panic!("未导入：{other:?}"),
            })
            .collect()
    }

    fn original(&self, i: usize) -> PathBuf {
        self.library.original_path(&self.ids[i]).unwrap()
    }

    fn config(&self, models: Vec<kinshoko_core::tagging::ModelSpec>) -> TaggingConfig {
        let mut config = TaggingConfig::new(self.dir.path().join("models"), models);
        config.base_url = self.server.base_url().to_owned();
        config.retry_delay = Duration::from_millis(20);
        config
    }

    fn start(&self, config: TaggingConfig) -> Tagging {
        Tagging::start(self.library.clone(), Arc::new(self.fake.clone()), config)
    }
}

fn raw(name: &str, category: u8, score: f32) -> RawTag {
    RawTag {
        name: name.into(),
        category,
        score,
    }
}

fn wait_for(tagging: &Tagging, what: &str, f: impl Fn(&TaggingStatus) -> bool) -> TaggingStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = tagging.status();
        if f(&status) {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "等待{what}超时，当前状态 {status:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn idle(tagging: &Tagging) -> TaggingStatus {
    wait_for(tagging, "打标完成", |s| {
        matches!(s, TaggingStatus::Idle { .. })
    })
}

/// 有效标签：(命名空间, 显示名, 出处)。
fn tags_of(library: &Library, id: &str) -> Vec<(TagNamespace, String, Vec<TagOrigin>)> {
    let tags: ImageTags = library.image_tags(id, ZH).unwrap();
    let mut out: Vec<_> = tags
        .tags
        .into_iter()
        .map(|t| (t.tag.namespace, t.tag.name, t.origins))
        .collect();
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out
}

fn model_origin(score: f32) -> Vec<TagOrigin> {
    vec![TagOrigin::Source {
        source: "model:test-tagger".into(),
        score: Some(score),
    }]
}

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

#[test]
fn after_repeated_gpu_resets_tagging_falls_back_to_the_cpu_model() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.lose_device_on(&f.original(0), 2);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let tagging = f.start(f.config(vec![gpu, cpu]));
    tagging.download();
    wait_for(&tagging, "退回 CPU 时询问下载", |s| {
        matches!(
            s,
            TaggingStatus::NeedsDownload {
                fallback: Some(_),
                ..
            }
        )
    });
    tagging.download();
    let status = idle(&tagging);

    assert!(matches!(
        status,
        TaggingStatus::Idle {
            device: Device::Cpu,
            ..
        }
    ));
    assert_eq!(
        f.fake.tagged().into_iter().map(|t| t.1).collect::<Vec<_>>(),
        vec![Device::Cpu]
    );
}

#[test]
fn without_a_discrete_gpu_the_cpu_model_is_used() {
    let f = Fixture::new(1);
    f.fake.set_gpu(None);
    f.fake.set_available_ram(16_000_000_000);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let tagging = f.start(f.config(vec![gpu.clone(), cpu.clone()]));
    let status = wait_for(&tagging, "需要下载模型", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert!(
        matches!(&status, TaggingStatus::NeedsDownload { model, .. } if *model == cpu.label),
        "{status:?}"
    );
    tagging.download();
    idle(&tagging);
    assert_eq!(f.fake.started(), vec![(cpu.key.clone(), Device::Cpu)]);
    assert!(
        !f.server
            .requests()
            .iter()
            .any(|(path, _)| *path == support::model_path(&gpu, &gpu.file)),
        "不下载用不上的显卡模型"
    );
}

#[test]
fn choosing_cpu_in_settings_uses_the_cpu_even_with_a_gpu() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let mut config = f.config(vec![gpu, cpu.clone()]);
    config.preferred = Some(Device::Cpu);
    let tagging = f.start(config);
    let status = wait_for(&tagging, "需要下载模型", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert!(
        matches!(&status, TaggingStatus::NeedsDownload { model, fallback: None, .. } if *model == cpu.label),
        "{status:?}"
    );
    tagging.download();
    idle(&tagging);
    assert_eq!(f.fake.started(), vec![(cpu.key.clone(), Device::Cpu)]);
}

#[test]
fn switching_the_hardware_asks_before_downloading_it_and_never_retags() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let mut config = f.config(vec![gpu.clone(), cpu.clone()]);
    config.poll_interval = Duration::from_millis(20);
    let tagging = f.start(config);
    tagging.download();
    idle(&tagging);
    assert_eq!(f.fake.started(), vec![(gpu.key.clone(), Device::DirectMl)]);

    tagging.set_device(Some(Device::Cpu));
    let status = wait_for(&tagging, "CPU 档需要下载", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert!(
        matches!(&status, TaggingStatus::NeedsDownload { model, .. } if *model == cpu.label),
        "换了硬件档要重新确认下载：{status:?}"
    );
    tagging.download();
    wait_for(&tagging, "换用 CPU 档", |s| {
        matches!(
            s,
            TaggingStatus::Idle {
                device: Device::Cpu,
                ..
            }
        )
    });
    assert_eq!(f.fake.tagged().len(), 1, "已经打过标的图不随换档重打");
    let later = f.import(10..11);
    tagging.wake();
    wait_for(&tagging, "新图打标", |_| f.fake.tagged().len() == 2);
    assert_eq!(
        f.fake.tagged()[1],
        (f.library.original_path(&later[0]).unwrap(), Device::Cpu)
    );

    // 换回自动：显卡文件已下载，不再询问；之前打过的图仍不重打。
    tagging.set_device(None);
    wait_for(&tagging, "换回显卡档", |s| {
        matches!(
            s,
            TaggingStatus::Idle {
                device: Device::DirectMl,
                ..
            }
        )
    });
    assert_eq!(f.fake.tagged().len(), 2, "换回显卡档也不重打");
}

#[test]
fn choosing_the_gpu_without_a_usable_gpu_stops_instead_of_using_the_cpu() {
    let f = Fixture::new(1);
    f.fake.set_gpu(None);
    f.fake.set_available_ram(16_000_000_000);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let store = ModelStore::new(f.dir.path().join("models"), f.server.base_url());
    store
        .prepare(&cpu, &mut |_| {}, &AtomicBool::new(false))
        .unwrap();
    let mut config = f.config(vec![gpu, cpu]);
    config.preferred = Some(Device::DirectMl);
    let tagging = f.start(config);
    tagging.download();
    let status = wait_for(&tagging, "显卡不可用", |s| {
        matches!(s, TaggingStatus::NoDevice { .. })
    });
    assert_eq!(
        status,
        TaggingStatus::NoDevice {
            reason: "没有独立显卡".into()
        }
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(f.fake.started().is_empty(), "不退回 CPU 打标");
}

#[test]
fn choosing_the_gpu_with_too_little_video_memory_says_so() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(1_000_000_000));
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let mut config = f.config(vec![gpu, cpu]);
    config.preferred = Some(Device::DirectMl);
    let tagging = f.start(config);
    let status = wait_for(&tagging, "显存不够", |s| {
        matches!(s, TaggingStatus::NoDevice { .. })
    });
    let TaggingStatus::NoDevice { reason } = status else {
        unreachable!()
    };
    assert!(reason.contains("显存额度不够"), "{reason}");
    assert!(
        !reason.contains("测试模型"),
        "原因里不出现模型条目名：{reason}"
    );
}

#[test]
fn automatic_falls_back_to_the_cpu_but_asks_before_downloading_it() {
    let f = Fixture::new(1);
    f.fake.set_gpu(None);
    f.fake.set_available_ram(16_000_000_000);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let tagging = f.start(f.config(vec![gpu, cpu.clone()]));
    let status = wait_for(&tagging, "需要下载 CPU 档", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert_eq!(
        status,
        TaggingStatus::NeedsDownload {
            model: cpu.label.clone(),
            size: cpu.size,
            downloaded: 0,
            fallback: Some("没有独立显卡".into()),
        }
    );
}

#[test]
fn a_confirmed_gpu_download_does_not_download_the_cpu_model_after_falling_back() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    f.fake.set_available_ram(16_000_000_000);
    f.fake.lose_device_on(&f.original(0), 2);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let tagging = f.start(f.config(vec![gpu, cpu.clone()]));
    tagging.download();
    let status = wait_for(&tagging, "退回 CPU 时询问下载", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert!(
        matches!(&status, TaggingStatus::NeedsDownload { model, fallback: Some(reason), .. }
            if *model == cpu.label && reason.contains("显卡多次出错")),
        "{status:?}"
    );
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !f.server
            .requests()
            .iter()
            .any(|(path, _)| *path == support::model_path(&cpu, &cpu.file)),
        "退回 CPU 时不自动下载"
    );
}

#[test]
fn the_hardware_list_shows_each_tiers_needs_and_whether_it_is_downloaded() {
    let f = Fixture::new(0);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let mut cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    cpu.ram_need = 5_000_000_000;
    let store = ModelStore::new(f.dir.path().join("models"), f.server.base_url());
    store
        .prepare(&gpu, &mut |_| {}, &AtomicBool::new(false))
        .unwrap();

    let choice = store.choice(&[gpu.clone(), cpu.clone()], Some(Device::Cpu));
    assert_eq!(
        choice,
        ModelChoice {
            model: "测试模型".into(),
            selected: Some(Device::Cpu),
            options: vec![
                HardwareOption {
                    device: Device::DirectMl,
                    vram_need: 1_800_000_000,
                    ram_need: 0,
                    size: 9,
                    downloaded: true,
                },
                HardwareOption {
                    device: Device::Cpu,
                    vram_need: 1_800_000_000,
                    ram_need: 5_000_000_000,
                    size: 9,
                    downloaded: false,
                },
            ],
        }
    );
}

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

    let requests: Vec<_> = f
        .server
        .requests()
        .into_iter()
        .filter(|(p, _)| *p == path)
        .map(|(_, range)| range)
        .collect();
    assert_eq!(requests, vec![None, Some(100_000)], "第二次从断点续传");
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
        }
    );
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

#[test]
fn the_status_names_the_gpu_in_use_and_none_on_the_cpu() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let mut config = f.config(vec![gpu, cpu]);
    config.poll_interval = Duration::from_millis(20);
    let tagging = f.start(config);
    tagging.download();
    let TaggingStatus::Idle { gpu, .. } = idle(&tagging) else {
        unreachable!()
    };
    assert_eq!(gpu.as_deref(), Some("测试显卡"));

    tagging.set_device(Some(Device::Cpu));
    wait_for(&tagging, "CPU 档需要下载", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    tagging.download();
    let status = wait_for(&tagging, "换用 CPU 档", |s| {
        matches!(
            s,
            TaggingStatus::Idle {
                device: Device::Cpu,
                ..
            }
        )
    });
    assert!(
        matches!(status, TaggingStatus::Idle { gpu: None, .. }),
        "{status:?}"
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
