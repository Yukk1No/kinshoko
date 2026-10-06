//! 自动标签（#52）：模型下载与校验、打标调度、按模型来源写入建议与分级、子进程崩溃后恢复。
//! 资料库用临时目录里的真库；打标子进程用内存假实现，模型从本地测试服务下载。

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::RgbaImage;
use kinshoko_core::Library;
use kinshoko_core::library::{
    ContentRating, ImageTags, ImportOutcome, ImportSource, TagEdit, TagNamespace, TagOrigin, TagRef,
};
use kinshoko_core::tagging::{
    Device, InMemoryTagger, RawTag, Tagging, TaggingConfig, TaggingStatus,
};
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
