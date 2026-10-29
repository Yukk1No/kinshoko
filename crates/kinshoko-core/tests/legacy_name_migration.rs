//! Old names remain visible until the user confirms the whole migration batch.
use image::{Rgba, RgbaImage};
use kinshoko_core::library::{
    LocalizedName, TagNamespace, TagRef, TagTranslation, TagTranslations,
};
use kinshoko_core::{
    Library,
    tag_catalog::{LegacyNameDecision, LegacyNameResolution, TagCatalog},
};
use std::{collections::BTreeMap, path::Path};

fn old_library(dir: &Path, name: &str, old_name: &str) -> (Library, String, String) {
    use sha2::{Digest, Sha256};
    let root = dir.join(name);
    std::fs::create_dir_all(&root).unwrap();
    let image_id = format!("{name}-image");
    let local_id = format!("{name}-local-parted");
    let bytes = {
        let image = RgbaImage::from_pixel(3, 3, Rgba([18, 28, 38, 255]));
        let mut data = std::io::Cursor::new(Vec::new());
        image.write_to(&mut data, image::ImageFormat::Png).unwrap();
        data.into_inner()
    };
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let relative = format!("originals/{}/{}.png", &hash[..2], hash);
    let original = root.join(&relative);
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, &bytes).unwrap();
    // Construct the released v16 SQLite format before opening it with the new application.
    let conn = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
    conn.execute_batch(include_str!("fixtures/spec78-legacy-v16.sql"))
        .unwrap();
    conn.execute(
        "INSERT INTO library VALUES (?1,?2,1,1000)",
        rusqlite::params![format!("{name}-library"), name],
    )
    .unwrap();
    conn.execute("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at) VALUES (?1,?2,?3,'png',?4,3,3,1,'old.png',1000)", rusqlite::params![image_id, hash, bytes.len() as i64, relative]).unwrap();
    conn.execute("INSERT INTO tag VALUES (?1,'general',1000)", [&local_id])
        .unwrap();
    conn.execute(
        "INSERT INTO tag_name VALUES (?1,'zh-CN',?2)",
        rusqlite::params![local_id, old_name],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tag_external VALUES ('parted_hair',?1)",
        [&local_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tag_fact VALUES (?1,?2,'model:old',0.9)",
        rusqlite::params![image_id, local_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tag_decision VALUES (?1,?2,'add',1000)",
        rusqlite::params![image_id, local_id],
    )
    .unwrap();
    drop(conn);
    let library = Library::open(&root).unwrap();
    assert_eq!(
        std::fs::read(library.original_path(&image_id).unwrap()).unwrap(),
        bytes
    );
    (library, image_id, local_id)
}
fn defaults() -> TagTranslations {
    TagTranslations {
        entries: vec![TagTranslation {
            external: "parted_hair".into(),
            names: BTreeMap::from([("zh-CN".into(), "分缝发型".into())]),
            aliases: vec![],
        }],
    }
}
fn label(catalog: &mut TagCatalog, lib: &Library, image: &str) -> String {
    catalog.image_tags(lib, image, "zh-CN").unwrap().image.tags[0]
        .tag
        .name
        .clone()
}
#[test]
fn cancelling_keeps_old_displays_and_confirmation_applies_one_shared_choice_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a, local_a) = old_library(dir.path(), "a", "分发");
    let (b, image_b, local_b) = old_library(dir.path(), "b", "分开的头发");
    let before_a = a.image_tags(&image_a, "zh-CN").unwrap();
    let before_b = b.image_tags(&image_b, "zh-CN").unwrap();
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.install_name_defaults(defaults()).unwrap();
    catalog.synchronize(&a).unwrap();
    let snapshot = catalog.synchronize(&b).unwrap();
    let plan = catalog.plan_name_migration(&snapshot).unwrap();
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups[0].sources.len(), 2);
    assert_eq!(plan.groups[0].default_name.as_deref(), Some("分缝发型"));
    assert_eq!(label(&mut catalog, &a, &image_a), "分发");
    assert_eq!(label(&mut catalog, &b, &image_b), "分开的头发");
    drop(catalog); // Closing the wizard has no persistent action.
    let mut catalog = TagCatalog::open(&app).unwrap();
    let plan = catalog
        .plan_name_migration(&catalog.inspect().unwrap())
        .unwrap();
    catalog
        .confirm_name_migration(
            &plan,
            &[LegacyNameDecision {
                catalog_id: plan.groups[0].catalog_id.clone(),
                lang: "zh-CN".into(),
                resolution: LegacyNameResolution::KeepLegacy {
                    library_id: b.info().id.clone(),
                    local_tag_id: local_b.clone(),
                },
            }],
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a), "分开的头发");
    assert_eq!(label(&mut catalog, &b, &image_b), "分开的头发");
    assert!(
        catalog
            .plan_name_migration(&catalog.inspect().unwrap())
            .unwrap()
            .groups
            .is_empty()
    );
    assert_eq!(a.image_tags(&image_a, "zh-CN").unwrap(), before_a);
    assert_eq!(b.image_tags(&image_b, "zh-CN").unwrap(), before_b);
    assert_eq!(
        catalog
            .local_tag_ids(&a.info().id, &plan.groups[0].catalog_id)
            .unwrap(),
        [local_a]
    );
    assert_eq!(
        catalog.inspect().unwrap().tags[0].name_preferences,
        [LocalizedName {
            lang: "zh-CN".into(),
            name: "分开的头发".into()
        }]
    );
}

#[test]
fn explicit_preferences_do_not_hide_unconfirmed_old_sources_and_follow_default_removes_only_that_language()
 {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a, _) = old_library(dir.path(), "a", "分发");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.install_name_defaults(defaults()).unwrap();
    let id = catalog.synchronize(&a).unwrap().tags[0].id.clone();
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "自然分缝".into(),
            },
        )
        .unwrap();
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "en".into(),
                name: "Personal English".into(),
            },
        )
        .unwrap();
    let (b, image_b, _) = old_library(dir.path(), "b", "分开的头发");
    let snapshot = catalog.synchronize(&b).unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a), "自然分缝");
    assert_eq!(label(&mut catalog, &b, &image_b), "自然分缝");
    let plan = catalog.plan_name_migration(&snapshot).unwrap();
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(
        plan.groups[0].existing_preference.as_deref(),
        Some("自然分缝")
    );
    assert!(
        plan.groups[0]
            .sources
            .iter()
            .any(|source| source.legacy_name == "分开的头发" && source.current_name == "自然分缝")
    );
    catalog
        .confirm_name_migration(
            &plan,
            &[LegacyNameDecision {
                catalog_id: id.clone(),
                lang: "zh-CN".into(),
                resolution: LegacyNameResolution::FollowDefault,
            }],
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a), "分缝发型");
    assert_eq!(label(&mut catalog, &b, &image_b), "分缝发型");
    assert_eq!(
        catalog.inspect().unwrap().tags[0].name_preferences,
        [LocalizedName {
            lang: "en".into(),
            name: "Personal English".into()
        }]
    );
    let (c, image_c, _) = old_library(dir.path(), "c", "左右分发");
    let snapshot = catalog.synchronize(&c).unwrap();
    assert_eq!(label(&mut catalog, &c, &image_c), "分缝发型");
    let later = catalog.plan_name_migration(&snapshot).unwrap();
    assert_eq!(later.groups[0].sources.len(), 1);
    assert_eq!(later.groups[0].sources[0].legacy_name, "左右分发");
    assert!(
        catalog
            .confirm_name_migration(
                &plan,
                &[LegacyNameDecision {
                    catalog_id: id,
                    lang: "zh-CN".into(),
                    resolution: LegacyNameResolution::FollowDefault
                }]
            )
            .is_err()
    );
}

#[test]
#[ignore = "subprocess entry for fault injection"]
fn child_confirms_until_fault() {
    let root = std::path::PathBuf::from(std::env::var_os("T04_FAULT_ROOT").unwrap());
    let mut catalog = TagCatalog::open(&root.join("app")).unwrap();
    let plan = catalog
        .plan_name_migration(&catalog.inspect().unwrap())
        .unwrap();
    let decisions = plan
        .groups
        .iter()
        .map(|group| LegacyNameDecision {
            catalog_id: group.catalog_id.clone(),
            lang: group.lang.clone(),
            resolution: LegacyNameResolution::KeepLegacy {
                library_id: group.sources[0].library_id.clone(),
                local_tag_id: group.sources[0].local_tag_id.clone(),
            },
        })
        .collect::<Vec<_>>();
    let result = catalog.confirm_name_migration(&plan, &decisions);
    if std::env::var("KINSHOKO_FAULT_ACTION").as_deref() == Ok("error") {
        assert!(result.is_err(), "injected storage failure must be reported");
    } else {
        result.unwrap();
    }
}

#[test]
fn interruption_and_write_failure_leave_the_entire_batch_pending_then_retry_is_stable() {
    for action in ["exit", "error"] {
        let dir = tempfile::tempdir().unwrap();
        let (a, image_a, _) = old_library(dir.path(), "a", "分发");
        a.edit_tags(
            std::slice::from_ref(&image_a),
            &[kinshoko_core::library::TagEdit::Add {
                tag: TagRef::Named {
                    namespace: TagNamespace::Artist,
                    name: "旧画师".into(),
                    lang: "zh-CN".into(),
                },
            }],
        )
        .unwrap();
        let before = a.image_tags(&image_a, "zh-CN").unwrap();
        let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
        let snapshot = catalog.synchronize(&a).unwrap();
        let plan = catalog.plan_name_migration(&snapshot).unwrap();
        assert_eq!(plan.groups.len(), 2);
        drop(catalog);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "child_confirms_until_fault",
                "--ignored",
                "--nocapture",
            ])
            .env("T04_FAULT_ROOT", dir.path())
            .env("KINSHOKO_FAULT", "legacy_name_after_choice@2")
            .env("KINSHOKO_FAULT_ACTION", action)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(if action == "exit" { 99 } else { 0 }));
        let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
        let retried = catalog
            .plan_name_migration(&catalog.inspect().unwrap())
            .unwrap();
        assert_eq!(retried, plan);
        assert!(
            catalog
                .inspect()
                .unwrap()
                .tags
                .iter()
                .all(|tag| tag.name_preferences.is_empty())
        );
        assert_eq!(a.image_tags(&image_a, "zh-CN").unwrap(), before);
        let decisions = retried
            .groups
            .iter()
            .map(|group| LegacyNameDecision {
                catalog_id: group.catalog_id.clone(),
                lang: group.lang.clone(),
                resolution: LegacyNameResolution::KeepLegacy {
                    library_id: group.sources[0].library_id.clone(),
                    local_tag_id: group.sources[0].local_tag_id.clone(),
                },
            })
            .collect::<Vec<_>>();
        let completed = catalog
            .confirm_name_migration(&retried, &decisions)
            .unwrap();
        assert!(
            catalog
                .plan_name_migration(&completed)
                .unwrap()
                .groups
                .is_empty()
        );
        assert!(
            catalog
                .confirm_name_migration(&retried, &decisions)
                .is_err()
        );
        assert_eq!(catalog.inspect().unwrap(), completed);
    }
}

#[test]
fn following_default_preserves_displaced_global_and_old_names_as_removable_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let (a, _, _) = old_library(dir.path(), "a", "分发");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.install_name_defaults(defaults()).unwrap();
    let id = catalog.synchronize(&a).unwrap().tags[0].id.clone();
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "自然分缝".into(),
            },
        )
        .unwrap();
    let plan = catalog
        .plan_name_migration(&catalog.inspect().unwrap())
        .unwrap();
    let snapshot = catalog
        .confirm_name_migration(
            &plan,
            &[LegacyNameDecision {
                catalog_id: id,
                lang: "zh-CN".into(),
                resolution: LegacyNameResolution::FollowDefault,
            }],
        )
        .unwrap();
    assert!(
        snapshot.tags[0]
            .aliases
            .iter()
            .any(|alias| alias.name == "自然分缝")
    );
    assert!(
        snapshot.tags[0]
            .aliases
            .iter()
            .any(|alias| alias.name == "分发")
    );
}

#[test]
fn equal_default_legacy_choice_remains_explicit_after_default_upgrade_and_keep_preference_acknowledges_only_new_sources()
 {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a, local_a) = old_library(dir.path(), "a", "分缝发型");
    let app = dir.path().join("app");
    let mut catalog = TagCatalog::open(&app).unwrap();
    catalog.install_name_defaults(defaults()).unwrap();
    let snapshot = catalog.synchronize(&a).unwrap();
    let plan = catalog.plan_name_migration(&snapshot).unwrap();
    let id = plan.groups[0].catalog_id.clone();
    catalog
        .confirm_name_migration(
            &plan,
            &[LegacyNameDecision {
                catalog_id: id.clone(),
                lang: "zh-CN".into(),
                resolution: LegacyNameResolution::KeepLegacy {
                    library_id: a.info().id.clone(),
                    local_tag_id: local_a,
                },
            }],
        )
        .unwrap();
    let mut update = defaults();
    update.entries[0]
        .names
        .insert("zh-CN".into(), "新默认".into());
    catalog.update_name_defaults(&update).unwrap();
    assert_eq!(label(&mut catalog, &a, &image_a), "分缝发型");
    let (b, image_b, _) = old_library(dir.path(), "b", "另一个旧名");
    let snapshot = catalog.synchronize(&b).unwrap();
    let plan = catalog.plan_name_migration(&snapshot).unwrap();
    assert_eq!(plan.groups[0].sources.len(), 1);
    catalog
        .confirm_name_migration(
            &plan,
            &[LegacyNameDecision {
                catalog_id: id,
                lang: "zh-CN".into(),
                resolution: LegacyNameResolution::KeepPreference,
            }],
        )
        .unwrap();
    assert_eq!(label(&mut catalog, &b, &image_b), "分缝发型");
    drop(catalog);
    let catalog = TagCatalog::open(&app).unwrap();
    assert!(
        catalog
            .plan_name_migration(&catalog.inspect().unwrap())
            .unwrap()
            .groups
            .is_empty()
    );
    assert_eq!(
        catalog.inspect().unwrap().tags[0].name_preferences[0].name,
        "分缝发型"
    );
}

#[test]
fn follow_default_preview_uses_the_actual_other_language_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let (a, _, _) = old_library(dir.path(), "a", "分发");
    let (b, image_b, local_b) = old_library(dir.path(), "b", "分开的头发");
    b.rename_tag(&local_b, "en", "My old English").unwrap();
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    catalog.install_name_defaults(defaults()).unwrap();
    catalog.synchronize(&a).unwrap();
    let snapshot = catalog.synchronize(&b).unwrap();
    let plan = catalog.plan_name_migration(&snapshot).unwrap();
    assert_eq!(
        plan.groups
            .iter()
            .find(|group| group.lang == "en")
            .unwrap()
            .default_name,
        None
    );
    let decisions = plan
        .groups
        .iter()
        .map(|group| LegacyNameDecision {
            catalog_id: group.catalog_id.clone(),
            lang: group.lang.clone(),
            resolution: LegacyNameResolution::FollowDefault,
        })
        .collect::<Vec<_>>();
    let preview = catalog.preview_name_migration(&plan, &decisions).unwrap();
    assert_eq!(
        preview
            .outcomes
            .iter()
            .find(|result| result.lang == "en")
            .unwrap()
            .display_name,
        "分缝发型"
    );
    let mut mixed = decisions.clone();
    mixed
        .iter_mut()
        .find(|decision| decision.lang == "zh-CN")
        .unwrap()
        .resolution = LegacyNameResolution::KeepLegacy {
        library_id: b.info().id.clone(),
        local_tag_id: local_b,
    };
    let preview = catalog.preview_name_migration(&plan, &mixed).unwrap();
    assert_eq!(
        preview
            .outcomes
            .iter()
            .find(|result| result.lang == "en")
            .unwrap()
            .display_name,
        "分开的头发"
    );
    assert!(
        catalog.inspect().unwrap().tags[0]
            .name_preferences
            .is_empty()
    );
    catalog.confirm_name_migration(&plan, &mixed).unwrap();
    assert_eq!(
        catalog.image_tags(&b, &image_b, "en").unwrap().image.tags[0]
            .tag
            .name,
        "分开的头发"
    );
}

#[test]
fn a_large_legacy_batch_resolves_by_identity_and_keeps_existing_global_preference_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let (a, image_a, _) = old_library(dir.path(), "a", "分发");
    let extra = (0..1200)
        .map(|index| kinshoko_core::library::TagEdit::Add {
            tag: TagRef::Named {
                namespace: TagNamespace::General,
                name: format!("普通旧名 {index}"),
                lang: "zh-CN".into(),
            },
        })
        .collect::<Vec<_>>();
    a.edit_tags(std::slice::from_ref(&image_a), &extra).unwrap();
    let before = a.image_tags(&image_a, "zh-CN").unwrap();
    let (b, _, _) = old_library(dir.path(), "b", "另一个旧名");
    let mut catalog = TagCatalog::open(&dir.path().join("app")).unwrap();
    let first = catalog.synchronize(&a).unwrap();
    let id = first
        .tags
        .iter()
        .find(|tag| !tag.external.is_empty())
        .unwrap()
        .id
        .clone();
    catalog.synchronize(&b).unwrap();
    catalog
        .set_name_preference(
            &id,
            &LocalizedName {
                lang: "zh-CN".into(),
                name: "全局指定".into(),
            },
        )
        .unwrap();
    let plan = catalog
        .plan_name_migration(&catalog.inspect().unwrap())
        .unwrap();
    assert_eq!(plan.groups.len(), 1201);
    let decisions = plan
        .groups
        .iter()
        .map(|group| LegacyNameDecision {
            catalog_id: group.catalog_id.clone(),
            lang: group.lang.clone(),
            resolution: if group.catalog_id == id {
                LegacyNameResolution::KeepPreference
            } else {
                LegacyNameResolution::FollowDefault
            },
        })
        .collect::<Vec<_>>();
    let preview = catalog.preview_name_migration(&plan, &decisions).unwrap();
    assert_eq!(preview.outcomes.len(), 1201);
    assert_eq!(
        preview
            .outcomes
            .iter()
            .find(|outcome| outcome.catalog_id == id)
            .unwrap()
            .display_name,
        "全局指定"
    );
    let snapshot = catalog.confirm_name_migration(&plan, &decisions).unwrap();
    assert!(
        catalog
            .plan_name_migration(&snapshot)
            .unwrap()
            .groups
            .is_empty()
    );
    assert_eq!(
        snapshot
            .tags
            .iter()
            .map(|tag| tag.name_preferences.len())
            .sum::<usize>(),
        1
    );
    assert_eq!(a.image_tags(&image_a, "zh-CN").unwrap(), before);
}
