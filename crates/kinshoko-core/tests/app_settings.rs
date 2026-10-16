//! 应用壳设置：本设备的开机自启与全局快捷键，保存在应用配置目录里的一个文件中。

use kinshoko_core::{AppSettings, ShortcutAction};

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
fn the_tagging_model_choice_is_automatic_until_the_artist_picks_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.tagging_model(), None);

    settings
        .set_tagging_model(Some("pixai-v1.0-fp32-chunked"))
        .unwrap();
    drop(settings);
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert_eq!(settings.tagging_model(), Some("pixai-v1.0-fp32-chunked"));

    settings.set_tagging_model(None).unwrap();
    assert_eq!(AppSettings::open(dir.path()).unwrap().tagging_model(), None);
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
fn the_usage_log_is_off_until_the_artist_turns_it_on_and_then_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    assert!(!settings.usage_log(), "使用日志默认关闭");

    settings.set_usage_log(true).unwrap();
    drop(settings);

    assert!(AppSettings::open(dir.path()).unwrap().usage_log());
}
