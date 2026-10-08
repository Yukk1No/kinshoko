//! T13: public configuration actions with real Library/SQLite/files.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    FactSource, ImportSource, LocalizedName, SourceTag, TagNamespace, TagRef,
};
use kinshoko_core::{
    AppSettings, Library, application_settings_backup::ApplicationSettingsBackup,
    tag_catalog::TagCatalog,
};
use std::path::Path;
fn tagged(dir: &Path) -> (Library, String) {
    let library = Library::create(&dir.join("library"), "资料库").unwrap();
    let file = dir.join("image.png");
    RgbaImage::from_pixel(5, 3, Rgba([10, 20, 30, 255]))
        .save(&file)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![file] }).wait();
    let id = report.items[0].outcome.image_id().unwrap();
    library.use_translations_for_new_tags(kinshoko_core::library::TagTranslations {
        entries: vec![kinshoko_core::library::TagTranslation {
            external: "parted_hair".into(),
            names: std::collections::BTreeMap::from([("zh-CN".into(), "分缝发型".into())]),
            aliases: vec![],
        }],
    });
    library
        .replace_source_tags(
            &FactSource::model("fixture"),
            id,
            &[SourceTag {
                tag: TagRef::External {
                    namespace: TagNamespace::General,
                    name: "parted_hair".into(),
                },
                score: None,
            }],
        )
        .unwrap();
    (library, id.to_owned())
}
#[test]
fn a_blank_application_restores_the_explicit_default_name_and_shell_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let (library, _image) = tagged(dir.path());
    let mut source = TagCatalog::open(&dir.path().join("source")).unwrap();
    let inspection = source.synchronize(&library).unwrap();
    let tag = &inspection.tags[0];
    let default = tag.default_names[0].clone();
    source.set_name_preference(&tag.id, &default).unwrap();
    let mut settings = AppSettings::open(&dir.path().join("source-config")).unwrap();
    settings.set_autostart(false).unwrap();
    settings.set_show_approx_source(true).unwrap();
    let package = dir.path().join("settings.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &source, &package).unwrap();
    let mut target = TagCatalog::open(&dir.path().join("target")).unwrap();
    let mut target_settings = AppSettings::open(&dir.path().join("target-config")).unwrap();
    ApplicationSettingsBackup::restore(&mut target_settings, &mut target, &package).unwrap();
    let restored = target.inspect().unwrap();
    assert_eq!(
        restored.tags.len(),
        1,
        "the package must explain names without the original library"
    );
    assert_eq!(
        restored.tags[0].name_preferences,
        vec![LocalizedName {
            lang: default.lang,
            name: default.name
        }]
    );
    assert!(!target_settings.autostart());
    assert!(target_settings.show_approx_source());
}

#[test]
fn replacement_keeps_deleted_aliases_and_migrated_rules_deleted_after_reconnect() {
    use kinshoko_core::approx::ApproxRelation;
    use kinshoko_core::library::{TagAlias, TagTranslation, TagTranslations};
    use kinshoko_core::tag_catalog::{CatalogApproxEdit, CatalogGroupEdit};
    let dir = tempfile::tempdir().unwrap();
    let (library, image) = tagged(dir.path());
    library
        .replace_source_tags(
            &FactSource::model("fixture"),
            &image,
            &[
                SourceTag {
                    tag: TagRef::External {
                        namespace: TagNamespace::General,
                        name: "parted_hair".into(),
                    },
                    score: None,
                },
                SourceTag {
                    tag: TagRef::External {
                        namespace: TagNamespace::General,
                        name: "long_hair".into(),
                    },
                    score: None,
                },
            ],
        )
        .unwrap();
    let locals = library
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.id)
        .collect::<Vec<_>>();
    let old = library.create_tag_group("旧分组", None).unwrap();
    library.set_tag_group_tags(&old, &locals).unwrap();
    library
        .set_tag_approx(&locals[0], &locals[1], ApproxRelation::Similar)
        .unwrap();
    let source_dir = dir.path().join("source");
    let mut source = TagCatalog::open(&source_dir).unwrap();
    let inspection = source.synchronize(&library).unwrap();
    let mut vocabulary = source.search_vocabulary(&library).unwrap();
    for tag in &mut vocabulary.tags {
        tag.id = inspection
            .mappings
            .iter()
            .find(|m| m.local_tag_id == tag.id)
            .unwrap()
            .catalog_id
            .clone();
    }
    let pair = inspection
        .tags
        .iter()
        .map(|t| t.id.clone())
        .collect::<Vec<_>>();
    let migrated = source.group_definitions().unwrap()[0].id.clone();
    source
        .edit_group(
            &CatalogGroupEdit::Delete { group_id: migrated },
            &vocabulary,
        )
        .unwrap();
    source
        .edit_approx(
            &CatalogApproxEdit::Remove {
                a: pair[0].clone(),
                b: pair[1].clone(),
            },
            &vocabulary,
        )
        .unwrap();
    let kept = source.create_group("保留的全局分组", None).unwrap();
    source
        .edit_group(
            &CatalogGroupEdit::AddMembers {
                group_id: kept.clone(),
                tag_ids: pair.clone(),
            },
            &vocabulary,
        )
        .unwrap();
    let alias = TagAlias {
        name: "旧叫法".into(),
        lang: Some("zh-CN".into()),
    };
    source.add_alias(&pair[0], &alias).unwrap();
    source.remove_alias(&pair[0], &alias).unwrap();
    let settings = AppSettings::open(&source_dir).unwrap();
    let package = dir.path().join("backup.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &source, &package).unwrap();
    let target_dir = dir.path().join("target");
    let mut target = TagCatalog::open(&target_dir).unwrap();
    target.create_group("不得合并回来", None).unwrap();
    let mut target_settings = AppSettings::open(&target_dir).unwrap();
    ApplicationSettingsBackup::restore(&mut target_settings, &mut target, &package).unwrap();
    assert_eq!(
        target
            .group_definitions()
            .unwrap()
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>(),
        vec!["保留的全局分组"]
    );
    assert_eq!(target.group_definitions().unwrap()[0].members, pair);
    drop(target);
    let mut target = TagCatalog::open(&target_dir).unwrap();
    target.synchronize(&library).unwrap();
    let external = target
        .inspect()
        .unwrap()
        .tags
        .into_iter()
        .find(|t| t.id == pair[0])
        .unwrap()
        .external[0]
        .name
        .clone();
    target
        .install_name_defaults(TagTranslations {
            entries: vec![TagTranslation {
                external,
                names: Default::default(),
                aliases: vec![alias.clone()],
            }],
        })
        .unwrap();
    assert!(
        !target
            .inspect()
            .unwrap()
            .tags
            .iter()
            .find(|t| t.id == pair[0])
            .unwrap()
            .aliases
            .contains(&alias)
    );
    assert_eq!(target.group_definitions().unwrap().len(), 1);
    assert!(
        target
            .group_migrations()
            .unwrap()
            .iter()
            .any(|m| m.source.group.id == old && m.target.is_none())
    );
    assert!(target.approx_definitions().unwrap().is_empty());
    assert!(
        target
            .approx_decisions()
            .unwrap()
            .iter()
            .any(|r| r.explicit && r.relation.is_none())
    );
    assert!(
        target
            .approx_migrations()
            .unwrap()
            .iter()
            .all(|m| m.confirmed)
    );
}

#[test]
fn restoring_settings_keeps_current_library_identity_corrections_and_every_image_fact() {
    use kinshoko_core::library::{ContentRating, ImageEdit, TagEdit};
    use kinshoko_core::tag_catalog::CatalogCorrection;
    let dir = tempfile::tempdir().unwrap();
    let (library, image) = tagged(dir.path());
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    let before = catalog.synchronize(&library).unwrap();
    let local = before.mappings[0].local_tag_id.clone();
    let mut settings = AppSettings::open(&app).unwrap();
    settings.set_safe_mode(false).unwrap();
    let package = dir.path().join("backup.kinshoko-settings");
    ApplicationSettingsBackup::export(&settings, &catalog, &package).unwrap();
    let corrected = catalog
        .correct(&library, &local, CatalogCorrection::Separate)
        .unwrap();
    let current_id = corrected.mappings[0].catalog_id.clone();
    catalog
        .set_name_preference(
            &current_id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "恢复前临时偏好".into(),
            },
        )
        .unwrap();
    let folder = library.create_folder("整理目录", None).unwrap();
    library
        .edit(
            std::slice::from_ref(&image),
            &[
                ImageEdit::SetNote {
                    text: "独立人工备注".into(),
                },
                ImageEdit::SetRating {
                    rating: ContentRating::General,
                },
                ImageEdit::AddToFolder { folder_id: folder },
            ],
        )
        .unwrap();
    library
        .edit_tags(
            std::slice::from_ref(&image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "人工标签".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    catalog.synchronize(&library).unwrap();
    let snapshot = (
        serde_json::to_value(library.image(&image).unwrap()).unwrap(),
        library.image_tags(&image, "zh-CN").unwrap(),
        library.image_rating(&image).unwrap(),
    );
    let original = std::fs::read(library.original_path(&image).unwrap()).unwrap();
    ApplicationSettingsBackup::restore(&mut settings, &mut catalog, &package).unwrap();
    let restored = catalog.synchronize(&library).unwrap();
    assert_eq!(
        restored
            .mappings
            .iter()
            .find(|m| m.local_tag_id == local)
            .unwrap()
            .catalog_id,
        current_id,
        "settings restore must not undo the current provider identity"
    );
    assert!(
        restored
            .tags
            .iter()
            .find(|t| t.id == current_id)
            .unwrap()
            .name_preferences
            .is_empty(),
        "absent preferences are replaced, not merged"
    );
    assert_eq!(
        (
            serde_json::to_value(library.image(&image).unwrap()).unwrap(),
            library.image_tags(&image, "zh-CN").unwrap(),
            library.image_rating(&image).unwrap()
        ),
        snapshot
    );
    assert_eq!(
        std::fs::read(library.original_path(&image).unwrap()).unwrap(),
        original
    );
}

#[test]
fn a_settings_write_failure_keeps_the_old_complete_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = TagCatalog::open(&dir.path().join("source")).unwrap();
    source.create_group("备份中的配置", None).unwrap();
    let mut source_settings = AppSettings::open(&dir.path().join("source-config")).unwrap();
    source_settings.set_autostart(false).unwrap();
    let package = dir.path().join("backup.kinshoko-settings");
    ApplicationSettingsBackup::export(&source_settings, &source, &package).unwrap();
    let target_dir = dir.path().join("target");
    let config = dir.path().join("target-config");
    let mut target = TagCatalog::open(&target_dir).unwrap();
    target.create_group("现有完整配置", None).unwrap();
    let mut settings = AppSettings::open(&config).unwrap();
    settings.set_autostart(true).unwrap();
    std::fs::remove_file(config.join("settings.json")).unwrap();
    std::fs::create_dir(config.join("settings.json")).unwrap();
    let error =
        ApplicationSettingsBackup::restore(&mut settings, &mut target, &package).unwrap_err();
    assert!(!error.is_empty());
    assert_eq!(
        target
            .group_definitions()
            .unwrap()
            .iter()
            .map(|g| g.name.as_str())
            .collect::<Vec<_>>(),
        vec!["现有完整配置"]
    );
    assert!(settings.autostart());
}

const RESTORE_CHILD: &str = "child_restores_until_configuration_fault";
#[test]
#[ignore = "executed by the crash parent with a real persistent configuration"]
fn child_restores_until_configuration_fault() {
    let dir =
        std::path::PathBuf::from(std::env::var_os("KINSHOKO_TEST_SETTINGS_RESTORE_DIR").unwrap());
    let mut catalog = TagCatalog::open(&dir.join("target")).unwrap();
    let mut settings = AppSettings::open(&dir.join("target-config")).unwrap();
    let result = ApplicationSettingsBackup::restore(
        &mut settings,
        &mut catalog,
        &dir.join("backup.kinshoko-settings"),
    );
    if std::env::var("KINSHOKO_FAULT_ACTION").as_deref() == Ok("error") {
        assert!(result.is_err());
    } else {
        result.unwrap();
    }
}
#[test]
fn restart_recovers_one_complete_configuration_after_catalog_publication_is_interrupted() {
    for point in [
        "settings_restore_after_journal",
        "settings_restore_after_catalog",
        "settings_restore_after_settings",
    ] {
        for action in ["crash", "error"] {
            let dir = tempfile::tempdir().unwrap();
            let mut source = TagCatalog::open(&dir.path().join("source")).unwrap();
            source.create_group("备份配置", None).unwrap();
            let mut source_settings = AppSettings::open(&dir.path().join("source-config")).unwrap();
            source_settings.set_autostart(false).unwrap();
            ApplicationSettingsBackup::export(
                &source_settings,
                &source,
                &dir.path().join("backup.kinshoko-settings"),
            )
            .unwrap();
            let mut target = TagCatalog::open(&dir.path().join("target")).unwrap();
            target.create_group("现有配置", None).unwrap();
            let mut target_settings = AppSettings::open(&dir.path().join("target-config")).unwrap();
            target_settings.set_autostart(true).unwrap();
            drop(target);
            drop(target_settings);
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([RESTORE_CHILD, "--exact", "--ignored", "--nocapture"])
                .env("KINSHOKO_TEST_SETTINGS_RESTORE_DIR", dir.path())
                .env("KINSHOKO_FAULT", point)
                .env("KINSHOKO_FAULT_ACTION", action)
                .status()
                .unwrap();
            assert_eq!(
                status.code(),
                Some(if action == "error" { 0 } else { 99 }),
                "{point} {action}"
            );
            ApplicationSettingsBackup::recover(
                &dir.path().join("target"),
                &dir.path().join("target-config"),
            )
            .unwrap();
            let mut recovered = TagCatalog::open(&dir.path().join("target")).unwrap();
            let mut settings = AppSettings::open(&dir.path().join("target-config")).unwrap();
            assert_eq!(recovered.group_definitions().unwrap()[0].name, "现有配置");
            assert!(settings.autostart());
            ApplicationSettingsBackup::restore(
                &mut settings,
                &mut recovered,
                &dir.path().join("backup.kinshoko-settings"),
            )
            .unwrap();
            assert_eq!(recovered.group_definitions().unwrap()[0].name, "备份配置");
            assert!(!settings.autostart());
        }
    }
}

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
