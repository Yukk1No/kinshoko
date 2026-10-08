//! 从文件导入模型包（#53）：没有网络时，画师把在别处下好的模型包（zip：模型文件与词表
//! `selected_tags.csv`）导入本机。按大小与 SHA-256 认出是哪个内置模型，校验不过的不装。
//! 资料库用临时目录里的真库；打标子进程用内存假实现。

mod support;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kinshoko_core::Library;
use kinshoko_core::library::{ImportOutcome, ImportSource};
use kinshoko_core::tagging::{
    Device, InMemoryTagger, ModelSpec, ModelStore, Tagging, TaggingConfig, TaggingStatus,
};
use support::{ModelServer, TAGS_CSV};

const MODEL: &[u8] = b"fake onnx model";

fn package(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join("模型包.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for (name, data) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
    path
}

fn specs(server: &ModelServer) -> (ModelSpec, ModelSpec) {
    (
        server.publish("gpu", Device::DirectMl, MODEL),
        server.publish("cpu", Device::Cpu, b"another model"),
    )
}

#[test]
fn an_imported_package_is_recognised_verified_and_used_without_network() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::create(&dir.path().join("lib"), "库").unwrap());
    let image = dir.path().join("a.png");
    image::RgbaImage::new(4, 4).save(&image).unwrap();
    let report = library.import(ImportSource { paths: vec![image] }).wait();
    assert!(matches!(
        report.items[0].outcome,
        ImportOutcome::Imported { .. }
    ));

    let server = ModelServer::start();
    let (gpu, cpu) = specs(&server);
    let fake = InMemoryTagger::new();
    fake.set_gpu(Some(4_000_000_000));
    let mut config = TaggingConfig::new(dir.path().join("models"), vec![gpu.clone(), cpu.clone()]);
    config.base_url = server.base_url().to_owned();
    config.poll_interval = Duration::from_millis(20);
    let tagging = Tagging::start(library, Arc::new(fake.clone()), config);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !matches!(tagging.status(), TaggingStatus::NeedsDownload { .. }) {
        assert!(Instant::now() < deadline, "{:?}", tagging.status());
        std::thread::sleep(Duration::from_millis(5));
    }

    // 包里的文件可以放在子文件夹中，名字不必与仓库一致。
    let pkg = package(
        dir.path(),
        &[
            ("pixai/model_fp16.onnx", MODEL),
            ("pixai/selected_tags.csv", TAGS_CSV.as_bytes()),
        ],
    );
    let store = ModelStore::new(dir.path().join("models"), server.base_url());
    let installed = store.import_package(&pkg, &[gpu.clone(), cpu.clone()]);
    assert_eq!(installed.map(|s| s.key), Ok(gpu.key.clone()));
    assert!(store.ready(&gpu).is_some());
    assert!(store.ready(&cpu).is_none());

    // 不用画师再确认下载，也不联网。
    tagging.wake();
    while !matches!(tagging.status(), TaggingStatus::Idle { .. }) {
        assert!(Instant::now() < deadline, "{:?}", tagging.status());
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fake.tagged().len(), 1);
    assert!(server.requests().is_empty(), "没有联网下载");
}

#[test]
fn a_package_with_a_damaged_model_is_rejected_and_nothing_is_installed() {
    let dir = tempfile::tempdir().unwrap();
    let server = ModelServer::start();
    let (gpu, cpu) = specs(&server);
    // 大小相同，内容不同。
    let damaged = b"fake onnx MODEL";
    let pkg = package(
        dir.path(),
        &[
            ("model_fp16.onnx", damaged),
            ("selected_tags.csv", TAGS_CSV.as_bytes()),
        ],
    );
    let models = dir.path().join("models");
    let store = ModelStore::new(models.clone(), server.base_url());
    let err = store
        .import_package(&pkg, &[gpu.clone(), cpu.clone()])
        .unwrap_err();
    assert!(err.contains("校验失败"), "{err}");
    assert!(store.ready(&gpu).is_none());
    let leftovers: Vec<_> = std::fs::read_dir(&models)
        .map(|d| d.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "没有留下文件：{leftovers:?}");
}

#[test]
fn a_package_of_an_unknown_model_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let server = ModelServer::start();
    let (gpu, cpu) = specs(&server);
    let pkg = package(
        dir.path(),
        &[
            ("other.onnx", b"a different model of another size"),
            ("selected_tags.csv", TAGS_CSV.as_bytes()),
        ],
    );
    let store = ModelStore::new(dir.path().join("models"), server.base_url());
    let err = store.import_package(&pkg, &[gpu, cpu]).unwrap_err();
    assert!(err.contains("不是"), "{err}");
}

#[test]
fn a_package_without_a_tag_list_or_model_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let server = ModelServer::start();
    let (gpu, cpu) = specs(&server);
    let store = ModelStore::new(dir.path().join("models"), server.base_url());
    let models = [gpu.clone(), cpu];

    let pkg = package(dir.path(), &[("model_fp16.onnx", MODEL)]);
    let err = store.import_package(&pkg, &models).unwrap_err();
    assert!(err.contains("selected_tags.csv"), "{err}");

    let pkg = package(
        dir.path(),
        &[
            ("model_fp16.onnx", MODEL),
            ("selected_tags.csv", b"just,some\nwords,here\n"),
        ],
    );
    let err = store.import_package(&pkg, &models).unwrap_err();
    assert!(err.contains("词表"), "{err}");

    let pkg = package(dir.path(), &[("selected_tags.csv", TAGS_CSV.as_bytes())]);
    let err = store.import_package(&pkg, &models).unwrap_err();
    assert!(err.contains(".onnx"), "{err}");
    assert!(store.ready(&gpu).is_none());

    let not_zip = dir.path().join("坏包.zip");
    std::fs::write(&not_zip, b"not a zip at all").unwrap();
    let err = store.import_package(&not_zip, &models).unwrap_err();
    assert!(err.contains("模型包"), "{err}");
}

/// 固定模型的词表也是固定的：内容、顺序与行数都要与模型一致，否则分数会对错标签（#76 Core1）。
#[test]
fn a_package_whose_tag_list_does_not_match_the_model_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let server = ModelServer::start();
    let (gpu, cpu) = specs(&server);
    let models = dir.path().join("models");
    let store = ModelStore::new(models.clone(), server.base_url());
    for (case, tags) in wrong_tag_lists() {
        let pkg = package(
            dir.path(),
            &[
                ("model_fp16.onnx", MODEL),
                ("selected_tags.csv", tags.as_bytes()),
            ],
        );
        let err = store
            .import_package(&pkg, &[gpu.clone(), cpu.clone()])
            .expect_err(case);
        assert!(err.contains("词表"), "{case}：{err}");
        assert!(store.ready(&gpu).is_none(), "{case}");
        let leftovers: Vec<_> = std::fs::read_dir(&models)
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "{case}：没有留下文件：{leftovers:?}");
    }
}

/// 格式都对、但与测试模型不配套的词表：无关、重排、截断。
fn wrong_tag_lists() -> Vec<(&'static str, String)> {
    let lines: Vec<&str> = TAGS_CSV.lines().collect();
    let mut reordered = lines.clone();
    reordered.swap(1, 2);
    vec![
        ("无关的词表", "name,category\ngeneral,9\n".to_owned()),
        ("顺序不同", reordered.join("\n") + "\n"),
        ("少了一行", lines[..lines.len() - 1].join("\n") + "\n"),
    ]
}

/// 新校验之前装好的模型目录里可能已有不配套的词表：不算就绪，重新准备时换回固定词表。
#[test]
fn an_installed_model_with_a_mismatched_tag_list_is_not_ready_until_prepared_again() {
    let dir = tempfile::tempdir().unwrap();
    let server = ModelServer::start();
    let (gpu, _) = specs(&server);
    let store = ModelStore::new(dir.path().join("models"), server.base_url());
    let never = std::sync::atomic::AtomicBool::new(false);
    let installed = store.prepare(&gpu, &mut |_| {}, &never).unwrap();
    for (case, tags) in wrong_tag_lists() {
        std::fs::write(&installed.tags_csv, &tags).unwrap();
        assert!(store.ready(&gpu).is_none(), "{case}");
        assert!(
            !store.options(std::slice::from_ref(&gpu))[0].installed,
            "{case}"
        );
        let again = store.prepare(&gpu, &mut |_| {}, &never).unwrap();
        assert_eq!(
            std::fs::read_to_string(&again.tags_csv).unwrap(),
            TAGS_CSV,
            "{case}"
        );
        assert!(store.ready(&gpu).is_some(), "{case}");
    }
}
