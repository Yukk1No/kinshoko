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
    Device, InMemoryTagger, ModelOption, ModelStore, RawTag, Tagging, TaggingConfig, TaggingStatus,
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
fn the_model_chosen_in_settings_is_used_even_with_a_gpu() {
    let f = Fixture::new(1);
    f.fake.set_gpu(Some(GPU_BUDGET));
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let mut config = f.config(vec![gpu, cpu.clone()]);
    config.preferred = Some(cpu.key.clone());
    let tagging = f.start(config);
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
}

#[test]
fn switching_the_model_asks_before_downloading_it_and_then_uses_it() {
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

    tagging.set_model(Some(cpu.key.clone()));
    let status = wait_for(&tagging, "新模型需要下载", |s| {
        matches!(s, TaggingStatus::NeedsDownload { .. })
    });
    assert!(
        matches!(&status, TaggingStatus::NeedsDownload { model, .. } if *model == cpu.label),
        "换了模型要重新确认下载：{status:?}"
    );
    tagging.download();
    wait_for(&tagging, "换用 CPU 模型", |s| {
        matches!(
            s,
            TaggingStatus::Idle {
                device: Device::Cpu,
                ..
            }
        )
    });
    let later = f.import(10..11);
    tagging.wake();
    wait_for(&tagging, "新图打标", |_| f.fake.tagged().len() == 2);
    assert_eq!(
        f.fake.tagged()[1],
        (f.library.original_path(&later[0]).unwrap(), Device::Cpu)
    );

    // 换回自动：显卡模型已下载，不再询问。
    tagging.set_model(None);
    wait_for(&tagging, "换回显卡模型", |s| {
        matches!(
            s,
            TaggingStatus::Idle {
                device: Device::DirectMl,
                ..
            }
        )
    });
}

#[test]
fn a_chosen_gpu_model_falls_back_to_the_cpu_model_without_a_gpu() {
    let f = Fixture::new(1);
    f.fake.set_gpu(None);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    let mut config = f.config(vec![cpu.clone(), gpu.clone()]);
    config.preferred = Some(gpu.key.clone());
    let tagging = f.start(config);
    tagging.download();
    idle(&tagging);
    assert_eq!(f.fake.started(), vec![(cpu.key.clone(), Device::Cpu)]);
}

#[test]
fn the_model_list_shows_each_models_needs_and_whether_it_is_installed() {
    let f = Fixture::new(0);
    let gpu = f.server.publish("gpu", Device::DirectMl, b"gpu model");
    let mut cpu = f.server.publish("cpu", Device::Cpu, b"cpu model");
    cpu.ram_need = 5_000_000_000;
    let store = ModelStore::new(f.dir.path().join("models"), f.server.base_url());
    store
        .prepare(&gpu, &mut |_| {}, &AtomicBool::new(false))
        .unwrap();

    let options = store.options(&[gpu.clone(), cpu.clone()]);
    assert_eq!(
        options,
        vec![
            ModelOption {
                key: gpu.key.clone(),
                label: gpu.label.clone(),
                device: Device::DirectMl,
                vram_need: 1_800_000_000,
                ram_need: 0,
                size: 9,
                installed: true,
            },
            ModelOption {
                key: cpu.key.clone(),
                label: cpu.label.clone(),
                device: Device::Cpu,
                vram_need: 1_800_000_000,
                ram_need: 5_000_000_000,
                size: 9,
                installed: false,
            },
        ]
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
