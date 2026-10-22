//! 硬件档：显卡与 CPU 档的选择、退让、换档时的下载确认。

use super::*;

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
            cancelled: false,
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
