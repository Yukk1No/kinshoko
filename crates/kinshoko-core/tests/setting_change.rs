//! 程序设置的统一改动入口（#527）：每种改动应用后能读回，重开设置也还在；值不合法时原来的设置不变。

use kinshoko_core::{AppSettings, SettingChange, TagDisplay, TagStyle, ViewerBackground};

fn reopened(dir: &tempfile::TempDir, change: SettingChange) -> AppSettings {
    let mut settings = AppSettings::open(dir.path()).unwrap();
    settings.apply(&change).unwrap();
    drop(settings);
    AppSettings::open(dir.path()).unwrap()
}

#[test]
fn every_switch_is_read_back_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    assert!(reopened(&dir, SettingChange::ShowApproxSource { on: true }).show_approx_source());
    assert!(
        reopened(&dir, SettingChange::KeepSelectionOnSafeMode { on: true })
            .keep_selection_on_safe_mode()
    );
    assert!(reopened(&dir, SettingChange::ForceSrgb { on: true }).force_srgb());
    assert!(reopened(&dir, SettingChange::PinEdgeContrast { on: true }).pin_edge_contrast());
    assert!(!reopened(&dir, SettingChange::Autostart { on: false }).autostart());
    assert!(reopened(&dir, SettingChange::InspectorOpen { open: true }).inspector_open());
}

#[test]
fn values_are_read_back_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let display = TagDisplay {
        style: TagStyle::Grouped,
        high: 0.7,
        low: 0.3,
    };
    assert_eq!(
        reopened(&dir, SettingChange::TagDisplay { display }).tag_display(),
        display
    );
    assert_eq!(
        reopened(
            &dir,
            SettingChange::ViewerBackground {
                background: ViewerBackground::Checker
            }
        )
        .viewer_background(),
        Some(ViewerBackground::Checker)
    );
    assert_eq!(
        reopened(&dir, SettingChange::InspectorWidth { width: 412 }).inspector_width(),
        Some(412)
    );
}

#[test]
fn crossed_tag_thresholds_are_refused_and_the_settings_stay_as_they_were() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();
    let crossed = TagDisplay {
        high: 0.4,
        low: 0.6,
        ..TagDisplay::default()
    };

    assert!(
        settings
            .apply(&SettingChange::TagDisplay { display: crossed })
            .is_err()
    );
    assert_eq!(settings.tag_display(), TagDisplay::default());
    drop(settings);
    assert_eq!(
        AppSettings::open(dir.path()).unwrap().tag_display(),
        TagDisplay::default()
    );
}

#[test]
fn an_out_of_range_details_panel_width_stops_at_the_edge() {
    let dir = tempfile::tempdir().unwrap();
    let mut settings = AppSettings::open(dir.path()).unwrap();

    settings
        .apply(&SettingChange::InspectorWidth { width: 100 })
        .unwrap();
    assert_eq!(settings.inspector_width(), Some(280));
    settings
        .apply(&SettingChange::InspectorWidth { width: 2000 })
        .unwrap();
    assert_eq!(settings.inspector_width(), Some(560));
}

#[test]
fn the_frontend_shape_names_the_setting_and_its_value() {
    let change: SettingChange =
        serde_json::from_str(r#"{"kind":"keepSelectionOnSafeMode","on":true}"#).unwrap();
    assert_eq!(change, SettingChange::KeepSelectionOnSafeMode { on: true });
    let change: SettingChange =
        serde_json::from_str(r#"{"kind":"viewerBackground","background":"light"}"#).unwrap();
    assert_eq!(
        change,
        SettingChange::ViewerBackground {
            background: ViewerBackground::Light
        }
    );
}
