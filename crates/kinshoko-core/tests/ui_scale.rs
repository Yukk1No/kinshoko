//! 界面缩放（#173）：主窗口按固定档位整体放大或缩小，只存在本机，不进程序设置备份。

use kinshoko_core::application_settings_backup::ApplicationSettingsBackup;
use kinshoko_core::tag_catalog::TagCatalog;
use kinshoko_core::{AppSettings, UI_SCALE_LEVELS, UiScale};

#[test]
fn the_levels_are_fixed_and_a_fresh_install_follows_the_system_at_100_percent() {
    let dir = tempfile::tempdir().unwrap();

    assert_eq!(UI_SCALE_LEVELS, [80, 90, 100, 110, 125, 150, 175, 200]);
    assert_eq!(UiScale::open(dir.path()).unwrap().percent(), 100);
}

#[test]
fn a_chosen_level_is_remembered_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut scale = UiScale::open(dir.path()).unwrap();

    scale.set(125).unwrap();
    drop(scale);

    assert_eq!(UiScale::open(dir.path()).unwrap().percent(), 125);
}

#[test]
fn a_percentage_that_is_not_one_of_the_levels_is_refused_and_nothing_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut scale = UiScale::open(dir.path()).unwrap();
    scale.set(150).unwrap();

    assert!(scale.set(120).is_err());

    assert_eq!(scale.percent(), 150);
    assert_eq!(UiScale::open(dir.path()).unwrap().percent(), 150);
}

#[test]
fn an_unreadable_or_out_of_range_file_falls_back_to_100_percent() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ui-scale.json");

    std::fs::write(&file, b"not json").unwrap();
    assert_eq!(UiScale::open(dir.path()).unwrap().percent(), 100);

    std::fs::write(&file, br#"{"percent": 333}"#).unwrap();
    assert_eq!(UiScale::open(dir.path()).unwrap().percent(), 100);
}

#[test]
fn the_settings_backup_neither_carries_the_ui_scale_nor_overwrites_it_on_restore() {
    let dir = tempfile::tempdir().unwrap();
    let source_config = dir.path().join("source-config");
    let target_config = dir.path().join("target-config");
    let source = TagCatalog::open(&dir.path().join("source")).unwrap();
    let settings = AppSettings::open(&source_config).unwrap();
    UiScale::open(&source_config).unwrap().set(200).unwrap();
    let package = dir.path().join("settings.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &source, &package).unwrap();

    let bytes = std::fs::read_to_string(&package).unwrap();
    assert!(!bytes.contains("percent") && !bytes.to_lowercase().contains("uiscale"));

    UiScale::open(&target_config).unwrap().set(80).unwrap();
    let mut target = TagCatalog::open(&dir.path().join("target")).unwrap();
    let mut target_settings = AppSettings::open(&target_config).unwrap();
    ApplicationSettingsBackup::restore(&mut target_settings, &mut target, &package).unwrap();

    assert_eq!(UiScale::open(&target_config).unwrap().percent(), 80);
}
