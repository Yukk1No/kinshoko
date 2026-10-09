//! #78 T12: content backup uses real public Library/TagCatalog/Backup actions.
use image::{Rgba, RgbaImage};
use kinshoko_core::backup::{BackupSources, BackupTarget, ScopeSelection, Stamp, compute_scope};
use kinshoko_core::library::{
    ImportSource, LocalizedName, TagAlias, TagEdit, TagNamespace, TagRef,
};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::tag_catalog::{CatalogCorrection, TagCatalog};
use kinshoko_core::{Library, RegisteredLibrary};
use std::path::Path;

fn at(hour: i64) -> Stamp {
    Stamp::new(1_791_158_400_000 + hour * 3_600_000, 480)
}

fn tagged(root: &Path, name: &str, seed: u8) -> (Library, String, String) {
    let library = Library::create(&root.join(name), name).unwrap();
    let input = root.join(format!("{name}.png"));
    RgbaImage::from_fn(24, 16, |x, y| Rgba([seed, x as u8, y as u8, 255]))
        .save(&input)
        .unwrap();
    let report = library.import(ImportSource { paths: vec![input] }).wait();
    let image = report.items[0].outcome.image_id().unwrap().to_owned();
    library
        .edit_tags(
            std::slice::from_ref(&image),
            &[TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "白".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
    let local = library.vocabulary().unwrap().tags[0].id.clone();
    (library, image, local)
}

fn registration(library: &Library) -> RegisteredLibrary {
    RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }
}

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

use kinshoko_core::desktop::{Placement, Region, SavedPin};
use kinshoko_core::library::{ContentRating, ImageEdit};

fn pin(library: &Library, image: &str, name: &str) -> SavedPin {
    SavedPin::reference(
        name,
        &library.info().id,
        &kinshoko_core::library::ReferenceImage {
            id: image.into(),
            width: 24,
            height: 16,
            sealed: false,
        },
        Some(Region {
            x: 2,
            y: 3,
            width: 8,
            height: 6,
        }),
        Placement {
            x: 123,
            y: 234,
            scale: 1.75,
            flip_h: true,
            flip_v: false,
            rotation: 1,
        },
    )
    .unwrap()
}

#[test]
fn independent_content_restore_keeps_existing_app_preferences_and_shared_groups() {
    let temp = tempfile::tempdir().unwrap();
    let (a, image_a, local_a) = tagged(temp.path(), "A", 50);
    let (b, image_b, local_b) = tagged(temp.path(), "B", 51);
    a.edit_tags(
        std::slice::from_ref(&image_a),
        &[
            TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::Artist,
                    name: "白".into(),
                    lang: "zh-CN".into(),
                },
            },
            TagEdit::Reject {
                tag: TagRef::Named {
                    namespace: TagNamespace::General,
                    name: "拒绝项".into(),
                    lang: "zh-CN".into(),
                },
            },
        ],
    )
    .unwrap();
    let parent = a.create_folder("人物", None).unwrap();
    let child = a.create_folder("头部", Some(&parent)).unwrap();
    a.edit(
        std::slice::from_ref(&image_a),
        &[
            ImageEdit::SetNote {
                text: "人工备注".into(),
            },
            ImageEdit::AddToFolder { folder_id: child },
            ImageEdit::SetRating {
                rating: ContentRating::Sensitive,
            },
        ],
    )
    .unwrap();
    let mut source_app = TagCatalog::open(&temp.path().join("source-app")).unwrap();
    source_app.synchronize(&a).unwrap();
    let shared_a = source_app
        .inspect()
        .unwrap()
        .mappings
        .iter()
        .find(|m| m.local_tag_id == local_a)
        .unwrap()
        .catalog_id
        .clone();
    source_app
        .correct(
            &b,
            &local_b,
            CatalogCorrection::Use {
                catalog_id: shared_a.clone(),
            },
        )
        .unwrap();
    let shared_b = source_app
        .correct(&b, &local_b, CatalogCorrection::Separate)
        .unwrap()
        .mappings
        .iter()
        .find(|m| m.library_id == b.info().id && m.local_tag_id == local_b)
        .unwrap()
        .catalog_id
        .clone();
    assert_ne!(shared_a, shared_b);
    let alias = TagAlias {
        name: "旧别名".into(),
        lang: None,
    };
    source_app.add_alias(&shared_a, &alias).unwrap();
    source_app
        .set_name_preference(
            &shared_a,
            &LocalizedName {
                name: "源程序偏好".into(),
                lang: "zh-CN".into(),
            },
        )
        .unwrap();
    let source_groups = ReferenceGroups::open(&temp.path().join("source-groups")).unwrap();
    let source_group = source_groups
        .create(
            "跨库参考",
            &mut [pin(&a, &image_a, "A-pin"), pin(&b, &image_b, "B-pin")],
        )
        .unwrap();
    let registry = [registration(&a), registration(&b)];
    let scope = compute_scope(
        &registry,
        &source_groups.list().unwrap(),
        &ScopeSelection::All,
    );
    let target_dir = temp.path().join("backup");
    std::fs::create_dir_all(&target_dir).unwrap();
    let backup = BackupTarget::new(&target_dir);
    let saved = backup
        .run_with_catalog(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &source_groups,
            },
            &source_app.inspect().unwrap(),
            at(1),
            &mut |_| {},
        )
        .unwrap();
    assert!(saved.complete);
    let destination_groups = ReferenceGroups::open(&temp.path().join("target-groups")).unwrap();
    let first = backup
        .restore(
            &saved.snapshot_id,
            &temp.path().join("first-restore"),
            &destination_groups,
            at(2),
        )
        .unwrap();
    let mut target_app = TagCatalog::open(&temp.path().join("target-app")).unwrap();
    for restored in &first.libraries {
        let copy = Library::open(&restored.library.root).unwrap();
        target_app.synchronize(&copy).unwrap();
    }
    let fresh_tag = target_app
        .inspect()
        .unwrap()
        .tags
        .into_iter()
        .find(|tag| tag.id == shared_a)
        .unwrap();
    assert!(fresh_tag.name_preferences.is_empty());
    assert_eq!(fresh_tag.default_names[0].name, "白");
    target_app
        .set_name_preference(
            &shared_a,
            &LocalizedName {
                name: "目标程序偏好".into(),
                lang: "zh-CN".into(),
            },
        )
        .unwrap();
    target_app.remove_alias(&shared_a, &alias).unwrap();
    let global_group = target_app.create_group("目标程序分组", None).unwrap();
    let mut device = kinshoko_core::DeviceLibraries::open(&temp.path().join("target-app")).unwrap();
    for restored in &first.libraries {
        device.add_registration(&restored.library.root).unwrap();
    }
    let mut workspace =
        kinshoko_core::workspace::Workspace::open(&temp.path().join("target-app")).unwrap();
    workspace
        .edit_approx(
            &device,
            &mut target_app,
            &kinshoko_core::tag_catalog::CatalogApproxEdit::Set {
                rules: vec![kinshoko_core::approx::PersonalApprox {
                    a: shared_a.clone(),
                    b: shared_b.clone(),
                    relation: kinshoko_core::approx::ApproxRelation::NotSimilar,
                }],
            },
            false,
        )
        .unwrap();
    let before_approx = target_app.approx_decisions().unwrap();
    let before_migrations = target_app.approx_migrations().unwrap();
    let before_groups = target_app.group_definitions().unwrap();
    let second = backup
        .restore(
            &saved.snapshot_id,
            &temp.path().join("second-restore"),
            &destination_groups,
            at(3),
        )
        .unwrap();
    assert!(second.check.passed(), "{:?}", second.check);
    for restored in &second.libraries {
        let source = if restored.old_id == a.info().id {
            &a
        } else {
            &b
        };
        assert_ne!(restored.library.id, source.info().id);
        let copy = Library::open(&restored.library.root).unwrap();
        copy.set_safe_mode(false);
        target_app.synchronize(&copy).unwrap();
        let image = if source.info().id == a.info().id {
            &image_a
        } else {
            &image_b
        };
        assert_eq!(copy.image(image).unwrap(), source.image(image).unwrap());
        assert_eq!(
            copy.image_tags(image, "zh-CN").unwrap(),
            source.image_tags(image, "zh-CN").unwrap()
        );
        assert_eq!(
            std::fs::read(copy.original_path(image).unwrap()).unwrap(),
            std::fs::read(source.original_path(image).unwrap()).unwrap()
        );
        assert_eq!(
            copy.restore_provenance().unwrap()[0].old_library_id,
            source.info().id
        );
    }
    let after = target_app.inspect().unwrap();
    let tag = after.tags.iter().find(|tag| tag.id == shared_a).unwrap();
    assert_eq!(tag.name_preferences[0].name, "目标程序偏好");
    assert!(!tag.aliases.iter().any(|a| a.name == "旧别名"));
    assert_eq!(target_app.group_definitions().unwrap(), before_groups);
    assert_eq!(target_app.approx_decisions().unwrap(), before_approx);
    assert_eq!(target_app.approx_migrations().unwrap(), before_migrations);
    assert_eq!(before_groups[0].id, global_group);
    assert_ne!(second.groups[0].id, source_group.id);
    let restored_group = destination_groups.get(&second.groups[0].id).unwrap();
    assert_eq!(
        restored_group.restored_from.as_ref().unwrap().group_id,
        source_group.id
    );
    for (after, before) in restored_group.members.iter().zip(&source_group.members) {
        assert_eq!(
            after.library_id,
            second
                .libraries
                .iter()
                .find(|lib| lib.old_id == before.library_id)
                .unwrap()
                .library
                .id
        );
        assert_eq!(after.image_id, before.image_id);
        assert_eq!(after.crop, before.crop);
        assert_eq!(after.placement, before.placement);
    }
    assert_eq!(
        after
            .mappings
            .iter()
            .find(|m| m.library_id
                == second
                    .libraries
                    .iter()
                    .find(|lib| lib.old_id == b.info().id)
                    .unwrap()
                    .library
                    .id
                && m.local_tag_id == local_b)
            .unwrap()
            .catalog_id,
        shared_b
    );
    drop(target_app);
    let reopened = TagCatalog::open(&temp.path().join("target-app")).unwrap();
    assert_eq!(
        reopened
            .inspect()
            .unwrap()
            .tags
            .iter()
            .find(|tag| tag.id == shared_a)
            .unwrap()
            .name_preferences[0]
            .name,
        "目标程序偏好"
    );
}

#[test]
#[ignore = "parent executes the fault child through public restore"]
fn content_restore_fault_child() {
    let root = std::path::PathBuf::from(std::env::var_os("KINSHOKO_T12_FAULT_ROOT").unwrap());
    let backup = BackupTarget::new(&root.join("backup"));
    let groups = ReferenceGroups::open(&root.join("target-groups")).unwrap();
    let snapshot = backup.snapshots().unwrap()[0].id.clone();
    let result = backup.restore(&snapshot, &root.join("restored"), &groups, at(2));
    if std::env::var("KINSHOKO_FAULT_ACTION").as_deref() == Ok("error") {
        assert!(result.is_err());
    } else {
        result.unwrap();
    }
}

#[test]
fn interrupted_and_failed_publication_rolls_back_only_its_batch_then_can_retry() {
    for point in [
        "content_restore_library_published",
        "content_restore_group_published",
    ] {
        for action in ["exit", "error"] {
            let temp = tempfile::tempdir().unwrap();
            let (a, image_a, _) = tagged(temp.path(), "A", 70);
            let (b, image_b, _) = tagged(temp.path(), "B", 71);
            let source_groups = ReferenceGroups::open(&temp.path().join("source-groups")).unwrap();
            source_groups
                .create("A-参考", &mut [pin(&a, &image_a, "A-pin")])
                .unwrap();
            source_groups
                .create("B-参考", &mut [pin(&b, &image_b, "B-pin")])
                .unwrap();
            let registry = [registration(&a), registration(&b)];
            let scope = compute_scope(
                &registry,
                &source_groups.list().unwrap(),
                &ScopeSelection::All,
            );
            let mut app = TagCatalog::open(&temp.path().join("app")).unwrap();
            app.synchronize(&a).unwrap();
            app.synchronize(&b).unwrap();
            let target_dir = temp.path().join("backup");
            std::fs::create_dir_all(&target_dir).unwrap();
            let backup = BackupTarget::new(&target_dir);
            let saved = backup
                .run_with_catalog(
                    &scope,
                    &BackupSources {
                        libraries: &registry,
                        groups: &source_groups,
                    },
                    &app.inspect().unwrap(),
                    at(1),
                    &mut |_| {},
                )
                .unwrap();
            let (old, old_image, old_local) = tagged(temp.path(), "existing", 72);
            let mut existing_app = TagCatalog::open(&temp.path().join("existing-app")).unwrap();
            let old_identity = existing_app
                .synchronize(&old)
                .unwrap()
                .mappings
                .iter()
                .find(|mapping| mapping.local_tag_id == old_local)
                .unwrap()
                .catalog_id
                .clone();
            existing_app
                .set_name_preference(
                    &old_identity,
                    &LocalizedName {
                        lang: "zh-CN".into(),
                        name: "保持旧设置".into(),
                    },
                )
                .unwrap();
            let groups = ReferenceGroups::open(&temp.path().join("target-groups")).unwrap();
            let old_group = groups
                .create("保持旧参考组", &mut [pin(&old, &old_image, "old-pin")])
                .unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "content_restore_fault_child",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                ])
                .env("KINSHOKO_T12_FAULT_ROOT", temp.path())
                .env("KINSHOKO_FAULT", format!("{point}@1"))
                .env("KINSHOKO_FAULT_ACTION", action)
                .status()
                .unwrap();
            assert_eq!(
                status.code(),
                Some(if action == "exit" { 99 } else { 0 }),
                "{point}/{action}"
            );
            let recovered = kinshoko_core::backup::recover_restores(&groups).unwrap();
            assert_eq!(recovered, if action == "exit" { 1 } else { 0 });
            assert_eq!(groups.get(&old_group.id).unwrap(), old_group);
            assert_eq!(groups.list().unwrap().len(), 1);
            assert_eq!(
                std::fs::read_dir(temp.path().join("restored"))
                    .unwrap()
                    .count(),
                0
            );
            assert_eq!(
                Library::inspect(&old.info().root).unwrap().id,
                old.info().id
            );
            assert_eq!(
                existing_app
                    .inspect()
                    .unwrap()
                    .tags
                    .iter()
                    .find(|tag| tag.id == old_identity)
                    .unwrap()
                    .name_preferences[0]
                    .name,
                "保持旧设置"
            );
            let retry = backup
                .restore(
                    &saved.snapshot_id,
                    &temp.path().join("restored"),
                    &groups,
                    at(3),
                )
                .unwrap();
            assert!(retry.check.passed(), "{point}/{action}: {:?}", retry.check);
            assert_eq!(retry.libraries.len(), 2);
            assert_eq!(retry.groups.len(), 2);
            assert_eq!(groups.list().unwrap().len(), 3);
            println!(
                "verified {point}/{action}: recovery={recovered}, existing library/group/preference retained, retry complete"
            );
        }
    }
}

#[test]
fn older_content_snapshot_cannot_replay_legacy_program_settings() {
    let temp = tempfile::tempdir().unwrap();
    let (source, image, local) = tagged(temp.path(), "source", 84);
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
    source.create_tag_group("旧版程序分组", None).unwrap();
    source
        .set_tag_approx(
            &local,
            &other,
            kinshoko_core::approx::ApproxRelation::Similar,
        )
        .unwrap();
    let registry = [registration(&source)];
    let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
    let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
    let target_dir = temp.path().join("backup");
    std::fs::create_dir_all(&target_dir).unwrap();
    let backup = BackupTarget::new(&target_dir);
    // Compatibility API produces the former whole-DB payload, without an app catalog adapter.
    let saved = backup
        .run(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            at(1),
            &mut |_| {},
        )
        .unwrap();
    let restored = backup
        .restore(
            &saved.snapshot_id,
            &temp.path().join("restored"),
            &groups,
            at(2),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
    let copy = Library::open(&restored.libraries[0].library.root).unwrap();
    let mut app = TagCatalog::open(&temp.path().join("target-app")).unwrap();
    let existing_group = app.create_group("当前程序分组", None).unwrap();
    app.synchronize(&copy).unwrap();
    assert_eq!(
        app.group_definitions()
            .unwrap()
            .iter()
            .map(|group| group.id.clone())
            .collect::<Vec<_>>(),
        [existing_group],
        "old content restore must not replay source settings"
    );
    assert!(copy.personal_approx("zh-CN").unwrap().is_empty());
    assert_eq!(source.personal_approx("zh-CN").unwrap().len(), 1);
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
