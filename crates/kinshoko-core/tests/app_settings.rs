//! 应用壳设置：本设备的开机自启与全局快捷键，保存在应用配置目录里的一个文件中。

use kinshoko_core::tagging::Device;
use kinshoko_core::{AppSettings, ShortcutAction, TagDisplay, TagStyle, UpdateChannel};

#[test]
fn a_fresh_install_starts_at_login_and_uses_snipaste_style_function_keys() {
    let dir = tempfile::tempdir().unwrap();

    let settings = AppSettings::open(dir.path()).unwrap();

    assert!(settings.autostart());
    assert_eq!(settings.shortcut(ShortcutAction::Capture), Some("F1"));
    assert_eq!(settings.shortcut(ShortcutAction::PinClipboard), Some("F3"));
    assert_eq!(settings.shortcut(ShortcutAction::HideAllPins), Some("F4"));
}

#[test]
fn turning_autostart_off_is_remembered_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();

    settings.set_autostart(false).unwrap();
    drop(settings);

    assert!(!AppSettings::open(dir.path()).unwrap().autostart());
}

#[test]
fn safe_mode_is_on_after_a_fresh_install_and_turning_it_off_is_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(settings.safe_mode());

    settings.set_safe_mode(false).unwrap();
    drop(settings);

    assert!(!AppSettings::open(dir.path()).unwrap().safe_mode());
}

#[test]
fn an_unreadable_settings_file_falls_back_to_defaults_and_is_kept_aside() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), "{ 写了一半").unwrap();

    let mut settings = AppSettings::open(dir.path()).unwrap();
    settings.set_autostart(false).unwrap();

    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.broken.json")).unwrap(),
        "{ 写了一半"
    );
}

#[test]
fn settings_written_by_a_newer_version_survive_a_round_trip_through_this_one() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{ "version": 1, "autostart": true, "pinOpacity": 0.8 }"#,
    )
    .unwrap();

    AppSettings::open(dir.path())
        .unwrap()
        .set_autostart(false)
        .unwrap();

    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["pinOpacity"], 0.8);
    assert_eq!(saved["autostart"], false);
}

#[test]
fn the_tagging_hardware_is_automatic_until_the_artist_picks_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.tagging_device(), None);

    settings.set_tagging_device(Some(Device::Cpu)).unwrap();
    drop(settings);
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.tagging_device(), Some(Device::Cpu));

    settings.set_tagging_device(None).unwrap();
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().tagging_device(),
        None
    );
}

#[test]
fn a_tagging_model_saved_by_an_older_version_becomes_its_hardware() {
    for (saved, device) in [
        (
            serde_json::json!("pixai-v1.0-fp16-chunked"),
            Some(Device::DirectMl),
        ),
        (
            serde_json::json!("pixai-v1.0-fp32-chunked"),
            Some(Device::Cpu),
        ),
        (serde_json::Value::Null, None),
        (serde_json::json!("不存在的模型"), None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::json!({ "version": 1, "taggingModel": saved }).to_string(),
        )
        .unwrap();
        assert_eq!(
            AppSettings::open(dir.path()).unwrap().tagging_device(),
            device,
            "旧设置 {saved}"
        );
    }
}

#[test]
fn choosing_automatic_replaces_a_tagging_model_saved_by_an_older_version() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"taggingModel":"pixai-v1.0-fp32-chunked"}"#,
    )
    .unwrap();
    AppSettings::open(dir.path())
        .unwrap()
        .set_tagging_device(None)
        .unwrap();
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().tagging_device(),
        None
    );
}

#[test]
fn showing_where_similar_tags_come_from_is_off_until_turned_on_and_then_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(!settings.show_approx_source(), "来源标记默认不显示");

    settings.set_show_approx_source(true).unwrap();
    drop(settings);

    assert!(AppSettings::open(dir.path()).unwrap().show_approx_source());
}

#[test]
fn toggling_safe_mode_clears_the_selection_until_the_artist_asks_to_keep_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(
        !settings.keep_selection_on_safe_mode(),
        "默认切换即清空选择"
    );

    settings.set_keep_selection_on_safe_mode(true).unwrap();
    drop(settings);

    assert!(
        AppSettings::open(dir.path())
            .unwrap()
            .keep_selection_on_safe_mode()
    );
}

#[test]
fn the_pin_edge_contrast_is_off_until_the_artist_turns_it_on_and_then_remembered() {
    // #239：钉图常驻阴影；浅色细线只在画师打开“增强钉图边缘”后才加。
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(!settings.pin_edge_contrast());

    settings.set_pin_edge_contrast(true).unwrap();
    drop(settings);

    assert!(AppSettings::open(dir.path()).unwrap().pin_edge_contrast());
}

#[test]
fn a_settings_file_from_before_the_pin_edge_contrast_reads_it_as_off() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"safeMode":false}"#,
    )
    .unwrap();
    let settings = AppSettings::open(dir.path()).unwrap();
    assert!(!settings.pin_edge_contrast());
    assert!(!settings.safe_mode(), "其他设置照常读出");
}

#[test]
fn native_pins_are_a_hidden_developer_setting_that_is_off_and_unwritten_by_default() {
    // #284：开发设置，界面上没有；只能手改 settings.json。
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(!settings.native_pins());
    settings.set_safe_mode(false).unwrap();
    let written = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
    assert!(!written.contains("nativePins"), "{written}");

    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"nativePins":true}"#,
    )
    .unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(settings.native_pins());
    settings.set_safe_mode(true).unwrap();
    assert!(
        AppSettings::open(dir.path()).unwrap().native_pins(),
        "改别的设置不会丢掉它"
    );
}

#[test]
fn forcing_srgb_is_off_after_a_fresh_install_and_only_takes_effect_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(!settings.force_srgb());
    assert!(!settings.force_srgb_in_effect());

    settings.set_force_srgb(true).unwrap();

    assert!(settings.force_srgb());
    assert!(
        !settings.force_srgb_in_effect(),
        "本次运行的 WebView2 已按旧值启动"
    );
    drop(settings);

    let restarted = AppSettings::open(dir.path()).unwrap();
    assert!(restarted.force_srgb());
    assert!(restarted.force_srgb_in_effect());
}

#[test]
fn the_run_log_is_on_by_default_only_in_test_builds() {
    use kinshoko_core::diagnostics::run_log_default_for_version;
    assert!(run_log_default_for_version("1.0.0-beta.2"));
    assert!(run_log_default_for_version("1.0.0-rc.1"));
    assert!(!run_log_default_for_version("1.0.0"));

    let dir = tempfile::tempdir().unwrap();
    let running = kinshoko_core::app_info().version;
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().run_log(),
        run_log_default_for_version(&running)
    );
}

#[test]
fn turning_the_run_log_off_is_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();

    settings.set_run_log(false).unwrap();
    drop(settings);
    assert!(!AppSettings::open(dir.path()).unwrap().run_log());

    AppSettings::open(dir.path())
        .unwrap()
        .set_run_log(true)
        .unwrap();
    assert!(AppSettings::open(dir.path()).unwrap().run_log());
}

#[test]
fn an_artist_who_turned_on_the_old_usage_log_keeps_logging_and_the_old_setting_goes_away() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"usageLog":true}"#,
    )
    .unwrap();

    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(settings.run_log(), "开过使用日志的，运行日志也开着");

    settings.set_run_log(false).unwrap();
    let saved = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
    assert!(!saved.contains("usageLog"), "{saved}");
    assert!(!AppSettings::open(dir.path()).unwrap().run_log());
}

#[test]
fn tag_display_defaults_to_confidence_bands_at_080_and_040_with_low_outline() {
    let dir = tempfile::tempdir().unwrap();
    let settings = AppSettings::open(dir.path()).unwrap();
    assert_eq!(
        settings.tag_display(),
        TagDisplay {
            style: TagStyle::Bands,
            high: 0.8,
            low: 0.4,
            low_outline: true,
        }
    );
}

#[test]
fn tag_display_changes_are_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let changed = TagDisplay {
        style: TagStyle::Grouped,
        high: 0.75,
        low: 0.5,
        low_outline: true,
    };
    settings.set_tag_display(changed).unwrap();
    drop(settings);

    assert_eq!(
        AppSettings::open(dir.path()).unwrap().tag_display(),
        changed
    );
}

#[test]
fn tag_display_rejects_a_low_ceiling_at_or_above_the_high_floor() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    for (high, low) in [(0.6, 0.6), (0.5, 0.7), (1.05, 0.4), (0.8, -0.05)] {
        let wrong = TagDisplay {
            high,
            low,
            ..settings.tag_display()
        };
        assert!(
            settings.set_tag_display(wrong).is_err(),
            "高档下限 {high}、低档上限 {low} 不应保存"
        );
    }
    drop(settings);
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().tag_display(),
        TagDisplay::default()
    );
}

#[test]
fn tag_display_fills_missing_fields_and_ignores_crossed_thresholds_in_the_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"tagDisplay":{"style":"grouped"}}"#,
    )
    .unwrap();
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().tag_display(),
        TagDisplay {
            style: TagStyle::Grouped,
            ..TagDisplay::default()
        }
    );

    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"tagDisplay":{"style":"grouped","high":0.3,"low":0.6,"lowOutline":true}}"#,
    )
    .unwrap();
    let read = AppSettings::open(dir.path()).unwrap().tag_display();
    assert_eq!(
        (read.high, read.low),
        (0.8, 0.4),
        "读到交叉的阈值时用默认阈值"
    );
    assert_eq!(read.style, TagStyle::Grouped);
    assert!(read.low_outline);
}

#[test]
fn the_details_panel_width_is_unset_until_the_artist_drags_it_and_then_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.inspector_width(), None);

    settings.set_inspector_width(412).unwrap();
    drop(settings);

    assert_eq!(
        AppSettings::open(dir.path()).unwrap().inspector_width(),
        Some(412)
    );
}

#[test]
fn the_details_panel_width_is_kept_between_280_and_560() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();

    settings.set_inspector_width(100).unwrap();
    assert_eq!(settings.inspector_width(), Some(280));
    settings.set_inspector_width(2000).unwrap();
    assert_eq!(settings.inspector_width(), Some(560));
}

#[test]
fn the_update_channel_follows_the_build_until_the_artist_picks_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let running = kinshoko_core::app_info().version;
    assert_eq!(
        settings.update_channel(),
        UpdateChannel::default_for_version(&running)
    );

    for picked in [UpdateChannel::Beta, UpdateChannel::Stable] {
        settings.set_update_channel(picked).unwrap();
        assert_eq!(
            AppSettings::open(dir.path()).unwrap().update_channel(),
            picked
        );
    }
}

#[test]
fn an_explicit_update_channel_wins_over_the_build_default() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"updateChannel":"beta"}"#,
    )
    .unwrap();
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().update_channel(),
        UpdateChannel::Beta
    );
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"updateChannel":"stable"}"#,
    )
    .unwrap();
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().update_channel(),
        UpdateChannel::Stable
    );
}

#[test]
fn the_build_default_channel_is_written_down_so_beta_users_stay_on_beta() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":1,"updateChannel":"beta"}"#,
    )
    .unwrap();
    let mut picked = AppSettings::open(dir.path()).unwrap();
    picked.remember_update_channel().unwrap();
    assert_eq!(
        picked.update_channel(),
        UpdateChannel::Beta,
        "画师选过的不改"
    );

    let fresh = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(fresh.path()).unwrap();
    let default = settings.update_channel();
    settings.remember_update_channel().unwrap();
    let written = std::fs::read_to_string(fresh.path().join("settings.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(
        json["updateChannel"],
        serde_json::to_value(default).unwrap(),
        "启动时按当前构建记下通道，装上新版本后仍按这个记录"
    );
}
