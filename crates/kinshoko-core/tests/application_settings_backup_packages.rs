//! 程序设置备份：无效或变化的包、两个身份共用一个词（接 `application_settings_backup.rs`）。

use super::*;

#[test]
fn invalid_or_changed_packages_leave_existing_configuration_usable() {
    let dir = tempfile::tempdir().unwrap();
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.create_group("当前配置", None).unwrap();
    let mut settings = AppSettings::open(&dir.path().join("config")).unwrap();
    settings
        .set_viewer_background(kinshoko_core::ViewerBackground::Light)
        .unwrap();
    let path = dir.path().join("backup.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &catalog, &path).unwrap();
    let preview = ApplicationSettingsBackup::inspect(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let mut package: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    package["version"] = 999.into();
    std::fs::write(&path, serde_json::to_vec(&package).unwrap()).unwrap();
    assert!(
        ApplicationSettingsBackup::restore(&mut settings, &mut catalog, &path)
            .unwrap_err()
            .to_string()
            .contains("兼容")
    );
    assert_eq!(catalog.group_definitions().unwrap()[0].name, "当前配置");
    std::fs::write(&path, bytes).unwrap();
    catalog.create_group("后来的配置", None).unwrap();
    ApplicationSettingsBackup::export(&settings, &catalog, &path).unwrap();
    assert!(
        ApplicationSettingsBackup::restore_checked(
            &mut settings,
            &mut catalog,
            &path,
            &preview.fingerprint
        )
        .unwrap_err()
        .to_string()
        .contains("变化")
    );
    assert_eq!(catalog.group_definitions().unwrap().len(), 2);
    let empty = TagCatalog::open(&dir.path().join("empty")).unwrap();
    let empty_settings = AppSettings::open(&dir.path().join("empty-config")).unwrap();
    ApplicationSettingsBackup::export(&empty_settings, &empty, &path).unwrap();
    ApplicationSettingsBackup::restore(&mut settings, &mut catalog, &path).unwrap();
    assert!(catalog.group_definitions().unwrap().is_empty());
    assert_eq!(
        settings.viewer_background(),
        Some(kinshoko_core::ViewerBackground::Mid)
    );
    settings
        .migrate_viewer_background(kinshoko_core::ViewerBackground::Light)
        .unwrap();
    assert_eq!(
        settings.viewer_background(),
        Some(kinshoko_core::ViewerBackground::Mid),
        "legacy storage must not undo a replacement"
    );
}

#[test]
fn restored_external_ownership_does_not_change_when_two_portable_identities_share_a_word() {
    use kinshoko_core::library::PackageOrigin;
    let dir = tempfile::tempdir().unwrap();
    let (library, image) = tagged(dir.path());
    let mut source = TagCatalog::open(&dir.path().join("source")).unwrap();
    let original_id = source.synchronize(&library).unwrap().mappings[0]
        .catalog_id
        .clone();
    let lens = library.take_reference_lens().unwrap();
    let mut snapshot = lens.snapshot(&image).unwrap();
    snapshot.tags[0].definition.as_mut().unwrap().id = "000-independent-portable-identity".into();
    let second = Library::create(&dir.path().join("second"), "独立定义来源").unwrap();
    second
        .import_from_package(
            &PackageOrigin {
                package_id: "fixture".into(),
                source_library_id: library.info().id.clone(),
                source_image_id: image.clone(),
                group_id: "fixture-group".into(),
                group_name: "参考组".into(),
                exported_at: 1,
                location: "fixture.kinshoko-group".into(),
            },
            &std::fs::read(lens.original_path(&image).unwrap()).unwrap(),
            &snapshot,
        )
        .unwrap();
    source.synchronize(&second).unwrap();
    let settings = AppSettings::open(&dir.path().join("source-config")).unwrap();
    let path = dir.path().join("backup.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &source, &path).unwrap();
    let mut restored = TagCatalog::open(&dir.path().join("restored")).unwrap();
    let mut settings = AppSettings::open(&dir.path().join("restored-config")).unwrap();
    ApplicationSettingsBackup::restore(&mut settings, &mut restored, &path).unwrap();
    let (third, _) = tagged(&dir.path().join("third"));
    let after = restored.synchronize(&third).unwrap();
    assert_eq!(
        after
            .mappings
            .iter()
            .find(|m| m.library_id == third.info().id)
            .unwrap()
            .catalog_id,
        original_id,
        "explicit external ownership is configuration, not alphabetical tag order"
    );
}
