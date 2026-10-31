//! 数据根目录（#145）：解析与首次启动迁移通过核心公开接口验收，使用临时目录中的真文件。

use std::path::Path;

use kinshoko_core::data_dirs::DataDirs;

fn all_paths(dirs: &DataDirs) -> Vec<std::path::PathBuf> {
    vec![
        dirs.device().to_path_buf(),
        dirs.settings().to_path_buf(),
        dirs.models().to_path_buf(),
        dirs.logs().to_path_buf(),
        dirs.webview().to_path_buf(),
    ]
}

#[test]
fn every_data_path_sits_under_data_next_to_the_exe() {
    let exe_dir = Path::new("C:/Users/画师/AppData/Local/Kinshoko");
    let dirs = DataDirs::resolve(exe_dir, None);

    assert_eq!(dirs.root(), exe_dir.join("data"));
    for path in all_paths(&dirs) {
        assert!(path.starts_with(exe_dir.join("data")), "{path:?}");
    }
    assert_eq!(dirs.models(), exe_dir.join("data").join("models"));
    assert_eq!(dirs.webview(), exe_dir.join("data").join("webview"));
}

#[test]
fn the_test_override_moves_every_path_including_settings() {
    let exe_dir = Path::new("C:/Kinshoko");
    let isolated = Path::new("D:/smoke/run-1");
    let dirs = DataDirs::resolve(exe_dir, Some(isolated.to_path_buf()));

    assert_eq!(dirs.root(), isolated);
    for path in all_paths(&dirs) {
        assert!(path.starts_with(isolated), "{path:?}");
    }
    assert_eq!(dirs.settings(), isolated);
}

#[test]
fn after_a_failed_migration_the_run_keeps_using_the_old_locations() {
    let legacy = kinshoko_core::data_dirs::LegacyDirs {
        roaming: Path::new("C:/Users/画师/AppData/Roaming/dev.kinshoko").to_path_buf(),
        local: Path::new("C:/Users/画师/AppData/Local/dev.kinshoko").to_path_buf(),
    };
    let dirs = DataDirs::legacy(&legacy);

    assert_eq!(dirs.settings(), legacy.roaming);
    assert_eq!(dirs.device(), legacy.roaming);
    assert_eq!(dirs.models(), legacy.local.join("models"));
    assert_eq!(dirs.logs(), legacy.local.join("logs"));
    // WebView2 在用户数据目录下自建 EBWebView：与旧版本的默认位置相同。
    assert_eq!(dirs.webview(), legacy.local);
}

mod migration {
    use std::fs;
    use std::path::{Path, PathBuf};

    use kinshoko_core::data_dirs::{LegacyDirs, Migration, migrate_legacy, migrate_legacy_with};

    /// 旧版本的布局：Roaming 里是设置与本设备数据，Local 里是模型、日志与 WebView2 数据。
    const ROAMING_FILES: [(&str, &str); 4] = [
        ("settings.json", r#"{"version":1,"autostart":true}"#),
        ("device.json", r#"{"libraries":["D:/参考图"]}"#),
        ("tag-catalog.sqlite", "SQLite format 3\0标签目录"),
        ("captures/2026-10-18 截图.png", "PNG 截图"),
    ];
    const LOCAL_FILES: [(&str, &str); 2] = [
        ("models/pixai-tagger-v0.9/model.onnx", "ONNX 权重"),
        ("logs/usage.log", "app.started"),
    ];
    const WEBVIEW_FILE: (&str, &str) = (
        "EBWebView/Default/Local Storage/leveldb/000003.log",
        "墙的滚动位置",
    );

    struct Layout {
        _dir: tempfile::TempDir,
        legacy: LegacyDirs,
        target: PathBuf,
    }

    fn write(root: &Path, files: &[(&str, &str)]) {
        for (rel, content) in files {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    fn old_layout() -> Layout {
        let dir = tempfile::tempdir().unwrap();
        let legacy = LegacyDirs {
            roaming: dir.path().join("Roaming/dev.kinshoko"),
            local: dir.path().join("Local/dev.kinshoko"),
        };
        write(&legacy.roaming, &ROAMING_FILES);
        write(&legacy.local, &LOCAL_FILES);
        write(&legacy.local, &[WEBVIEW_FILE]);
        let target = dir.path().join("Local/Kinshoko/data");
        Layout {
            _dir: dir,
            legacy,
            target,
        }
    }

    fn assert_files(root: &Path, files: &[(&str, &str)]) {
        for (rel, content) in files {
            assert_eq!(
                fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}")),
                *content,
                "{rel}"
            );
        }
    }

    #[test]
    fn first_start_moves_both_old_folders_into_data_and_leaves_a_note() {
        let layout = old_layout();

        let outcome = migrate_legacy(&layout.target, &layout.legacy).unwrap();

        assert_eq!(outcome, Migration::Migrated);
        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.target, &LOCAL_FILES);
        assert_files(&layout.target.join("webview"), &[WEBVIEW_FILE]);
        for old in [&layout.legacy.roaming, &layout.legacy.local] {
            assert!(!old.join("settings.json").exists() && !old.join("models").exists());
            let note = fs::read_to_string(old.join("MOVED.txt")).unwrap();
            assert!(
                note.contains(&layout.target.display().to_string()),
                "{note}"
            );
        }
    }

    #[test]
    fn entries_that_cannot_move_stay_put_and_the_note_names_them() {
        let layout = old_layout();
        // Local 里有一个与 Roaming 同名的条目：不能两份都放进 data，也不能丢。
        write(&layout.legacy.local, &[("device.json", "Local 里的另一份")]);

        migrate_legacy(&layout.target, &layout.legacy).unwrap();

        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.legacy.local, &[("device.json", "Local 里的另一份")]);
        let note = fs::read_to_string(layout.legacy.local.join("MOVED.txt")).unwrap();
        assert!(note.contains("device.json"), "{note}");
        assert!(!note.contains("可以删除"), "{note}");
        let note = fs::read_to_string(layout.legacy.roaming.join("MOVED.txt")).unwrap();
        assert!(note.contains("可以删除"), "{note}");
    }

    #[test]
    fn later_starts_do_not_migrate_again_or_overwrite_new_data() {
        let layout = old_layout();
        migrate_legacy(&layout.target, &layout.legacy).unwrap();
        let changed = r#"{"version":1,"autostart":false}"#;
        fs::write(layout.target.join("settings.json"), changed).unwrap();
        // 例如又运行了一次旧版本，旧位置重新出现了设置。
        write(&layout.legacy.roaming, &ROAMING_FILES[..1]);

        let outcome = migrate_legacy(&layout.target, &layout.legacy).unwrap();

        assert_eq!(outcome, Migration::NotNeeded);
        assert_files(&layout.target, &[("settings.json", changed)]);
        assert_files(&layout.legacy.roaming, &ROAMING_FILES[..1]);
    }

    #[test]
    fn nothing_happens_when_there_is_no_old_data() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = LegacyDirs {
            roaming: dir.path().join("Roaming/dev.kinshoko"),
            local: dir.path().join("Local/dev.kinshoko"),
        };
        let target = dir.path().join("Kinshoko/data");

        assert_eq!(
            migrate_legacy(&target, &legacy).unwrap(),
            Migration::NotNeeded
        );
        assert!(!legacy.roaming.exists() && !legacy.local.exists());
    }

    fn assert_old_layout_intact(layout: &Layout) {
        assert_files(&layout.legacy.roaming, &ROAMING_FILES);
        assert_files(&layout.legacy.local, &LOCAL_FILES);
        assert_files(&layout.legacy.local, &[WEBVIEW_FILE]);
        assert!(!layout.legacy.roaming.join("MOVED.txt").exists());
    }

    #[test]
    fn an_unwritable_target_keeps_the_old_data_and_the_next_start_retries() {
        let layout = old_layout();
        // 数据根目录的上一级被一个文件占着，什么也建不出来。
        let blocker = layout.target.parent().unwrap().to_path_buf();
        fs::write(&blocker, "不是文件夹").unwrap();

        assert!(migrate_legacy(&layout.target, &layout.legacy).is_err());
        assert_old_layout_intact(&layout);

        fs::remove_file(&blocker).unwrap();
        assert_eq!(
            migrate_legacy(&layout.target, &layout.legacy).unwrap(),
            Migration::Migrated
        );
        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.target, &LOCAL_FILES);
    }

    #[test]
    fn a_failure_halfway_puts_everything_back_and_the_next_start_retries() {
        let layout = old_layout();
        let mut calls = 0;
        let failing = |from: &Path, to: &Path| {
            calls += 1;
            if calls == 3 {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            fs::rename(from, to)
        };

        let error = migrate_legacy_with(&layout.target, &layout.legacy, failing).unwrap_err();
        assert!(error.legacy_intact);
        assert_old_layout_intact(&layout);
        assert!(!layout.target.exists() || fs::read_dir(&layout.target).unwrap().next().is_none());

        assert_eq!(
            migrate_legacy(&layout.target, &layout.legacy).unwrap(),
            Migration::Migrated
        );
        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.target, &LOCAL_FILES);
    }

    #[test]
    fn an_interrupted_migration_is_recovered_on_the_next_start() {
        let layout = old_layout();
        let mut calls = 0;
        // 模拟迁移到一半进程被结束（断电、任务管理器）：之后的代码一行也不跑。
        let crashing = |from: &Path, to: &Path| {
            calls += 1;
            if calls == 3 {
                panic!("进程在迁移中途结束");
            }
            fs::rename(from, to)
        };
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            migrate_legacy_with(&layout.target, &layout.legacy, crashing)
        }));
        assert!(crashed.is_err());

        assert_eq!(
            migrate_legacy(&layout.target, &layout.legacy).unwrap(),
            Migration::Migrated
        );
        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.target, &LOCAL_FILES);
        let names: Vec<_> = fs::read_dir(&layout.target)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(names.iter().all(|n| !n.contains("journal")), "{names:?}");
        assert!(!layout.target.with_file_name("data.migrating").exists());
    }

    #[test]
    fn a_failure_after_an_interruption_still_leaves_the_old_layout_whole() {
        let layout = old_layout();
        let mut calls = 0;
        let crashing = |from: &Path, to: &Path| {
            calls += 1;
            if calls == 3 {
                panic!("进程在迁移中途结束");
            }
            fs::rename(from, to)
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            migrate_legacy_with(&layout.target, &layout.legacy, crashing)
        }));

        // 下次启动又失败了：这次运行要回到旧位置，旧位置必须是完整的。
        let refusing =
            |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(migrate_legacy_with(&layout.target, &layout.legacy, refusing).is_err());
        assert_old_layout_intact(&layout);
    }

    #[test]
    fn when_putting_things_back_also_fails_the_error_says_the_old_layout_is_incomplete() {
        let layout = old_layout();
        let mut calls = 0;
        // 搬了两项之后磁盘出了问题：之后的改名全都失败，连放回原处也不行。
        let broken = |from: &Path, to: &Path| {
            calls += 1;
            if calls >= 3 {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            fs::rename(from, to)
        };

        let error = migrate_legacy_with(&layout.target, &layout.legacy, broken).unwrap_err();

        // 旧位置缺了东西：这次不能回到旧位置运行，否则会在那里新建空的设置与登记表。
        assert!(!error.legacy_intact);
        assert!(error.to_string().contains("data.migrating"), "{error}");
        // 下次启动磁盘恢复后，按日志放回再迁移，什么也不丢。
        assert_eq!(
            migrate_legacy(&layout.target, &layout.legacy).unwrap(),
            Migration::Migrated
        );
        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.target, &LOCAL_FILES);
    }

    #[test]
    fn old_data_on_another_volume_is_copied_and_then_removed() {
        let layout = old_layout();
        let old_root = layout
            .legacy
            .roaming
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let target_side = layout.target.parent().unwrap().to_path_buf();
        // 旧数据在 C:，程序装在 D:：从旧位置改名过去会失败，只能复制。
        let across_volumes = |from: &Path, to: &Path| {
            if from.starts_with(&old_root) && !from.starts_with(&target_side) {
                return Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices));
            }
            fs::rename(from, to)
        };

        assert_eq!(
            migrate_legacy_with(&layout.target, &layout.legacy, across_volumes).unwrap(),
            Migration::Migrated
        );
        assert_files(&layout.target, &ROAMING_FILES);
        assert_files(&layout.target, &LOCAL_FILES);
        assert!(!layout.legacy.roaming.join("settings.json").exists());
        assert!(!layout.legacy.local.join("models").exists());
        assert!(layout.legacy.local.join("MOVED.txt").exists());
    }

    #[test]
    fn a_failed_copy_to_another_volume_leaves_the_old_data_alone() {
        let layout = old_layout();
        let mut moves = 0;
        let across_volumes_then_fail = |from: &Path, to: &Path| {
            moves += 1;
            if moves == 4 {
                return Err(std::io::Error::from(std::io::ErrorKind::StorageFull));
            }
            if from.starts_with(layout.legacy.roaming.parent().unwrap()) {
                return Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices));
            }
            fs::rename(from, to)
        };

        assert!(
            migrate_legacy_with(&layout.target, &layout.legacy, across_volumes_then_fail).is_err()
        );
        assert_old_layout_intact(&layout);
        assert!(!layout.target.with_file_name("data.migrating").exists());
    }
}

/// 应用壳的源码检查。放在核心 crate 的测试里，是因为 CI 只跑核心 crate 的测试
/// （应用壳要链接 WebView2 与 DirectML，只在 Windows 上构建）。
mod shell_source {
    use std::path::{Path, PathBuf};

    /// 应用壳里除了解析数据根目录的 `data_dirs.rs` 以外的 Rust 源码。
    fn shell_sources() -> Vec<(PathBuf, String)> {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/src");
        let mut files = Vec::new();
        let mut pending = vec![src];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && !path.ends_with("data_dirs.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    files.push((path, text));
                }
            }
        }
        assert!(files.len() > 10, "没找到应用壳源码：{files:?}");
        files
    }

    /// 业务代码不再自己找数据目录，也不再自己读测试用的覆盖：都从 `data_dirs::app_data` 取。
    #[test]
    fn only_the_resolver_looks_up_data_locations() {
        let mut offenders = Vec::new();
        for (path, text) in shell_sources() {
            for needle in [
                "app_data_dir",
                "app_config_dir",
                "app_local_data_dir",
                "app_cache_dir",
                "app_log_dir",
                "KINSHOKO_DATA_DIR",
            ] {
                if text.contains(needle) {
                    offenders.push(format!("{}: {needle}", path.display()));
                }
            }
        }
        assert!(offenders.is_empty(), "{offenders:#?}");
    }

    /// 每个建窗口的地方都套上同一个 WebView2 用户数据目录与启动参数（`shared_webview`）。
    /// 唯一的例外是 pixiv 登录窗口（#368）：它打开外部网页，用自己的数据目录，退出登录时连同
    /// cookie 一起删掉。
    #[test]
    fn every_window_shares_one_webview2_environment() {
        let (mut builders, mut shared, mut stray) = (0, 0, Vec::new());
        for (path, text) in shell_sources() {
            if path.ends_with("subscription.rs") {
                assert_eq!(text.matches("WebviewWindowBuilder::new(").count(), 1);
                assert!(text.contains(".data_directory(login_profile("));
                assert!(!text.contains("additional_browser_args"));
                continue;
            }
            builders += text.matches("WebviewWindowBuilder::new(").count()
                + text.matches("WebviewWindowBuilder::from_config(").count();
            shared += text.matches(".shared_webview(").count();
            if text.contains("additional_browser_args") || text.contains("data_directory") {
                stray.push(path.display().to_string());
            }
        }
        assert!(builders >= 4, "{builders}");
        assert_eq!(builders, shared);
        assert!(stray.is_empty(), "{stray:#?}");
    }
}
