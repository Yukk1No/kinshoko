//! #78 T12: content backup uses real public Library/TagCatalog/Backup actions.

#[path = "support/backup_content.rs"]
mod backup_content;

use backup_content::*;

use image::{Rgba, RgbaImage};
use kinshoko_core::backup::{BackupSources, BackupTarget, ScopeSelection, compute_scope};
use kinshoko_core::library::{
    ImportSource, LocalizedName, TagAlias, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::tag_catalog::{CatalogCorrection, TagCatalog};
use kinshoko_core::{Library, RegisteredLibrary};

#[test]
fn content_backup_uses_current_pure_definitions_after_read_only_publication_failed() {
    let temp = tempfile::tempdir().unwrap();
    let (source, image, local) = tagged(temp.path(), "source", 23);
    let mut app = TagCatalog::open(&temp.path().join("app")).unwrap();
    let old_id = app.synchronize(&source).unwrap().mappings[0]
        .catalog_id
        .clone();
    let alias = TagAlias {
        name: "旧别名".into(),
        lang: Some("zh-CN".into()),
    };
    app.add_alias(&old_id, &alias).unwrap();
    app.publish_library_definitions(&source).unwrap();
    let expected = app
        .correct(&source, &local, CatalogCorrection::Separate)
        .unwrap()
        .mappings[0]
        .catalog_id
        .clone();
    app.add_alias(&expected, &alias).unwrap();
    app.remove_alias(&expected, &alias).unwrap();
    app.set_name_preference(
        &expected,
        &LocalizedName {
            name: "只属于程序的偏好".into(),
            lang: "zh-CN".into(),
        },
    )
    .unwrap();
    let provider = Library::open_read_only(&source.info().root, &source.info().id).unwrap();
    let stale = provider.tag_definition_dependencies().unwrap();
    assert!(app.publish_library_definitions(&provider).is_err());
    let registry = [registration(&source)];
    let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    let target_dir = temp.path().join("backup");
    std::fs::create_dir_all(&target_dir).unwrap();
    let backup = BackupTarget::new(&target_dir);
    let saved = backup
        .run_with_catalog(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            &app.inspect().unwrap(),
            at(1),
            &mut |_| {},
        )
        .unwrap();
    assert!(saved.complete, "{:?}", saved.problems);
    let restored_groups = ReferenceGroups::open(&temp.path().join("fresh/groups")).unwrap();
    let restored = backup
        .restore(
            &saved.snapshot_id,
            &temp.path().join("fresh/libraries"),
            &restored_groups,
            at(2),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
    let copy = Library::open(&restored.libraries[0].library.root).unwrap();
    let mut fresh = TagCatalog::open(&temp.path().join("fresh/app")).unwrap();
    let actual = fresh.synchronize(&copy).unwrap();
    assert_eq!(
        actual.mappings[0].catalog_id, expected,
        "content backup must carry app correction even when source publication failed"
    );
    let tag = actual.tags.iter().find(|tag| tag.id == expected).unwrap();
    assert_eq!(tag.default_names[0].name, "白");
    assert!(tag.name_preferences.is_empty());
    assert!(!tag.aliases.iter().any(|alias| alias.name == "旧别名"));
    assert_eq!(
        std::fs::read(copy.original_path(&image).unwrap()).unwrap(),
        std::fs::read(source.original_path(&image).unwrap()).unwrap()
    );
    assert_eq!(
        provider.tag_definition_dependencies().unwrap(),
        stale,
        "backup must not update the provider"
    );
}

#[test]
fn content_backup_does_not_reimport_legacy_application_groups_or_personal_rules() {
    let temp = tempfile::tempdir().unwrap();
    let (source, image, local) = tagged(temp.path(), "source", 24);
    source
        .edit_tags(
            std::slice::from_ref(&image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "雪".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let other = source
        .vocabulary()
        .unwrap()
        .tags
        .into_iter()
        .find(|tag| tag.id != local)
        .unwrap()
        .id;
    let legacy = source.create_tag_group("原程序的分组", None).unwrap();
    source
        .set_tag_group_tags(&legacy, &[local.clone(), other.clone()])
        .unwrap();
    source
        .set_tag_approx(
            &local,
            &other,
            kinshoko_core::approx::ApproxRelation::Similar,
        )
        .unwrap();
    let mut app = TagCatalog::open(&temp.path().join("app")).unwrap();
    app.synchronize(&source).unwrap();
    let registry = [registration(&source)];
    let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    let target_dir = temp.path().join("backup");
    std::fs::create_dir_all(&target_dir).unwrap();
    let backup = BackupTarget::new(&target_dir);
    let saved = backup
        .run_with_catalog(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            &app.inspect().unwrap(),
            at(1),
            &mut |_| {},
        )
        .unwrap();
    assert!(saved.complete);
    let destination_groups =
        ReferenceGroups::open(&temp.path().join("destination/groups")).unwrap();
    let restored = backup
        .restore(
            &saved.snapshot_id,
            &temp.path().join("destination/libraries"),
            &destination_groups,
            at(2),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
    let copy = Library::open(&restored.libraries[0].library.root).unwrap();
    let mut fresh = TagCatalog::open(&temp.path().join("destination/app")).unwrap();
    fresh.synchronize(&copy).unwrap();
    assert!(
        fresh.group_definitions().unwrap().is_empty(),
        "content restoration must not create a program tag group"
    );
    assert!(
        copy.personal_approx("zh-CN").unwrap().is_empty(),
        "legacy personal rules belong to program settings"
    );
    assert!(fresh.approx_decisions().unwrap().is_empty());
    assert!(fresh.approx_migrations().unwrap().is_empty());
    assert_eq!(source.tag_group_definitions().unwrap().len(), 1);
    assert_eq!(source.personal_approx("zh-CN").unwrap().len(), 1);
}

#[test]
fn a_later_library_restore_failure_does_not_leave_an_earlier_usable_copy() {
    let temp = tempfile::tempdir().unwrap();
    let (first, _, _) = tagged(temp.path(), "first", 31);
    let (last, last_image, _) = tagged(temp.path(), "last", 32);
    let registry = [registration(&first), registration(&last)];
    let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    let mut app = TagCatalog::open(&temp.path().join("app")).unwrap();
    app.synchronize(&first).unwrap();
    app.synchronize(&last).unwrap();
    let target_dir = temp.path().join("backup");
    std::fs::create_dir_all(&target_dir).unwrap();
    let backup = BackupTarget::new(&target_dir);
    let saved = backup
        .run_with_catalog(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            &app.inspect().unwrap(),
            at(1),
            &mut |_| {},
        )
        .unwrap();
    assert!(saved.complete);
    let last_bytes = std::fs::read(last.original_path(&last_image).unwrap()).unwrap();
    // Corrupt only the last provider's original. First provider restoration still succeeds.
    for shard in std::fs::read_dir(target_dir.join("kinshoko-backup/originals")).unwrap() {
        for file in std::fs::read_dir(shard.unwrap().path()).unwrap() {
            let path = file.unwrap().path();
            if std::fs::read(&path).unwrap() == last_bytes {
                std::fs::write(path, b"broken").unwrap();
            }
        }
    }
    let into = temp.path().join("restored");
    assert!(
        backup
            .restore(&saved.snapshot_id, &into, &groups, at(2))
            .is_err()
    );
    let usable = std::fs::read_dir(&into)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| Library::inspect(&entry.path()).is_ok())
        .count();
    assert_eq!(
        usable, 0,
        "a failed content restore must roll back every copy in its batch"
    );
    assert!(groups.list().unwrap().is_empty());
}

#[test]
fn incompatible_stable_identity_is_refused_before_content_is_published() {
    let temp = tempfile::tempdir().unwrap();
    let (source, _, local) = tagged(temp.path(), "source", 89);
    let mut app = TagCatalog::open(&temp.path().join("source-app")).unwrap();
    let shared = app
        .synchronize(&source)
        .unwrap()
        .mappings
        .iter()
        .find(|m| m.local_tag_id == local)
        .unwrap()
        .catalog_id
        .clone();
    let registry = [registration(&source)];
    let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    let target_dir = temp.path().join("backup");
    std::fs::create_dir_all(&target_dir).unwrap();
    let backup = BackupTarget::new(&target_dir);
    let saved = backup
        .run_with_catalog(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            &app.inspect().unwrap(),
            at(1),
            &mut |_| {},
        )
        .unwrap();
    let destination = Library::create(&temp.path().join("existing"), "existing").unwrap();
    let p = temp.path().join("artist.png");
    RgbaImage::from_pixel(24, 16, Rgba([90, 20, 40, 255]))
        .save(&p)
        .unwrap();
    let image = destination
        .import(ImportSource { paths: vec![p] })
        .wait()
        .items[0]
        .outcome
        .image_id()
        .unwrap()
        .to_owned();
    destination
        .edit_tags(
            &[image],
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::Artist,
                    name: "白".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let mut conflicting = destination.tag_definition_dependencies().unwrap();
    conflicting[0].definition.id = shared.clone();
    conflicting[0].authoritative = true;
    destination.publish_tag_definitions(&conflicting).unwrap();
    let mut target_app = TagCatalog::open(&temp.path().join("target-app")).unwrap();
    target_app.synchronize(&destination).unwrap();
    let before = target_app.inspect().unwrap();
    let into = temp.path().join("restore");
    let result = backup.restore_with_catalog(
        &saved.snapshot_id,
        &into,
        &groups,
        at(2),
        &target_app.inspect().unwrap(),
    );
    assert!(
        result.is_err(),
        "stable ID with another namespace must fail before content publication"
    );
    assert_eq!(target_app.inspect().unwrap(), before);
    assert_eq!(
        std::fs::read_dir(&into)
            .map(|entries| entries.count())
            .unwrap_or(0),
        0
    );
}

#[test]
#[ignore = "parent executes the real backup storage fault child"]
fn content_backup_fault_child() {
    let root =
        std::path::PathBuf::from(std::env::var_os("KINSHOKO_T12_BACKUP_FAULT_ROOT").unwrap());
    let info = Library::inspect(&root.join("source")).unwrap();
    let registry = [RegisteredLibrary {
        id: info.id,
        name: info.name,
        root: info.root,
    }];
    let groups = ReferenceGroups::open(&root.join("groups")).unwrap();
    let app = TagCatalog::open(&root.join("app")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    let report = BackupTarget::new(&root.join("backup"))
        .run_with_catalog(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            &app.inspect().unwrap(),
            at(1),
            &mut |_| {},
        )
        .unwrap();
    assert!(!report.complete);
    assert!(!report.problems.is_empty());
}

#[test]
fn backup_definition_storage_failure_or_exit_never_publishes_a_complete_snapshot() {
    for action in ["exit", "error"] {
        let temp = tempfile::tempdir().unwrap();
        let (source, _, local) = tagged(temp.path(), "source", 97);
        let mut app = TagCatalog::open(&temp.path().join("app")).unwrap();
        let expected = app
            .correct(&source, &local, CatalogCorrection::Separate)
            .unwrap()
            .mappings[0]
            .catalog_id
            .clone();
        app.set_name_preference(
            &expected,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "程序选择保持".into(),
            },
        )
        .unwrap();
        let stale = source.tag_definition_dependencies().unwrap();
        let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
        let target_dir = temp.path().join("backup");
        std::fs::create_dir_all(&target_dir).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "content_backup_fault_child",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("KINSHOKO_T12_BACKUP_FAULT_ROOT", temp.path())
            .env("KINSHOKO_FAULT", "portable_tags_publish_row@1")
            .env("KINSHOKO_FAULT_ACTION", action)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(if action == "exit" { 99 } else { 0 }));
        let backup = BackupTarget::new(&target_dir);
        assert!(backup.snapshots().unwrap().is_empty());
        assert_eq!(source.tag_definition_dependencies().unwrap(), stale);
        assert_eq!(
            app.inspect()
                .unwrap()
                .tags
                .iter()
                .find(|tag| tag.id == expected)
                .unwrap()
                .name_preferences[0]
                .name,
            "程序选择保持"
        );
        let registry = [registration(&source)];
        let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
        let retry = backup
            .run_with_catalog(
                &scope,
                &BackupSources {
                    libraries: &registry,
                    groups: &groups,
                },
                &app.inspect().unwrap(),
                at(2),
                &mut |_| {},
            )
            .unwrap();
        assert!(retry.complete);
        assert_eq!(backup.snapshots().unwrap().len(), 1);
        let restored = backup
            .restore(
                &retry.snapshot_id,
                &temp.path().join("restored"),
                &groups,
                at(3),
            )
            .unwrap();
        let copy = Library::open(&restored.libraries[0].library.root).unwrap();
        let mut fresh = TagCatalog::open(&temp.path().join("fresh")).unwrap();
        assert_eq!(
            fresh.synchronize(&copy).unwrap().mappings[0].catalog_id,
            expected
        );
        println!(
            "verified backup portable definition {action}: no complete snapshot, source/settings retained, retry complete"
        );
    }
}
