#[path = "support/backup_device.rs"]
mod backup_device;

use backup_device::{at, target};
use kinshoko_core::backup::{BackupSources, ScopeSelection, compute_scope};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary, interface_lang};

fn restored_names(name: &str, lang: &str) -> Vec<String> {
    interface_lang::set(lang).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let library = Library::create(&dir.path().join(name), name).unwrap();
    let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
    let registry = vec![RegisteredLibrary {
        id: library.info().id.clone(),
        name: library.info().name.clone(),
        root: library.info().root.clone(),
    }];
    let scope = compute_scope(&registry, &[], &ScopeSelection::All);
    let target = target(dir.path());
    let backup = target
        .run(
            &scope,
            &BackupSources {
                libraries: &registry,
                groups: &groups,
            },
            at(0, 3),
            &mut |_| {},
        )
        .unwrap();
    assert!(backup.complete, "{:?}", backup.problems);
    (0..3).map(|attempt| {
        let report = target.restore(&backup.snapshot_id, &dir.path().join("restored"), &groups, at(1, 1)).unwrap();
        assert!(report.check.passed(), "{:?}", report.check);
        let info = &report.libraries[0].library;
        assert_eq!(Library::open(&info.root).unwrap().info().name, info.name);
        let folder = info.root.file_name().unwrap().to_str().unwrap().to_owned();
        eprintln!("{lang} attempt={attempt}: bytes={} utf16={} prefix={} round_trip=passed reopen=passed", folder.len(), folder.encode_utf16().count(), folder.chars().take(6).collect::<String>());
        folder
    }).collect()
}

fn segment_units(name: &str) -> usize {
    #[cfg(windows)]
    {
        name.encode_utf16().count()
    }
    #[cfg(not(windows))]
    {
        name.len()
    }
}

#[test]
fn collision_restores_preserve_library_prefix_and_complete_suffix() {
    let name = format!("START-{}-END", "a".repeat(240));
    for lang in [interface_lang::ZH_CN, interface_lang::EN] {
        for (i, folder) in restored_names(&name, lang).iter().enumerate() {
            let suffix = if lang == interface_lang::EN {
                format!(" (restored {})", at(1, 1).local_date())
            } else {
                format!("\u{ff08}\u{6062}\u{590d} {}\u{ff09}", at(1, 1).local_date())
            };
            let suffix = if i == 0 {
                suffix
            } else {
                format!("{suffix} {}", i + 1)
            };
            assert!(folder.starts_with("START-"), "lost prefix: {folder}");
            assert!(folder.ends_with(&suffix), "lost suffix: {folder}");
            assert!(segment_units(folder) <= 255);
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_cjk_restore_keeps_names_that_fit_utf16() {
    let name = "\u{5e93}".repeat(200);
    for lang in [interface_lang::ZH_CN, interface_lang::EN] {
        for (i, folder) in restored_names(&name, lang).iter().enumerate() {
            let suffix = if lang == interface_lang::EN {
                format!(" (restored {})", at(1, 1).local_date())
            } else {
                format!("\u{ff08}\u{6062}\u{590d} {}\u{ff09}", at(1, 1).local_date())
            };
            let expected = if i == 0 {
                format!("{name}{suffix}")
            } else {
                format!("{name}{suffix} {}", i + 1)
            };
            assert_eq!(
                folder, &expected,
                "a fitting UTF-16 name must not be shortened"
            );
            assert!(segment_units(folder) <= 255);
        }
    }
}

#[test]
fn long_library_names_restore_with_bounded_folder_names() {
    let previous = interface_lang::current();
    for lang in [interface_lang::ZH_CN, interface_lang::EN] {
        interface_lang::set(lang).unwrap();
        for (case, name) in [
            ("ascii250", "a".repeat(250)),
            ("cjk249", "\u{5e93}".repeat(83)),
        ] {
            let dir = tempfile::tempdir().unwrap();
            eprintln!(
                "CASE {lang}/{case}: bytes={} utf16={}",
                name.len(),
                name.encode_utf16().count()
            );
            let library = Library::create(&dir.path().join(&name), &name).unwrap();
            eprintln!("CREATE OK");
            let groups = ReferenceGroups::open(&dir.path().join("groups")).unwrap();
            let registry = vec![RegisteredLibrary {
                id: library.info().id.clone(),
                name: library.info().name.clone(),
                root: library.info().root.clone(),
            }];
            let scope = compute_scope(&registry, &[], &ScopeSelection::All);
            let target = target(dir.path());
            let backup = target
                .run(
                    &scope,
                    &BackupSources {
                        libraries: &registry,
                        groups: &groups,
                    },
                    at(0, 3),
                    &mut |_| {},
                )
                .unwrap();
            assert!(backup.complete, "{:?}", backup.problems);
            eprintln!("BACKUP OK");
            for attempt in 0..3 {
                let report = target
                    .restore(
                        &backup.snapshot_id,
                        &dir.path().join("restored"),
                        &groups,
                        at(1, 1),
                    )
                    .expect("a valid library name must remain restorable");
                assert!(report.check.passed(), "{:?}", report.check);
                let folder = report.libraries[0]
                    .library
                    .root
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned();
                Library::open(&report.libraries[0].library.root).unwrap();
                assert!(segment_units(&folder) <= 255, "{folder}");
                let display_name = if lang == interface_lang::EN {
                    format!("{name} (restored)")
                } else {
                    format!("{name}\u{ff08}\u{6062}\u{590d}\u{ff09}")
                };
                assert_eq!(report.libraries[0].library.name, display_name);
                eprintln!(
                    "RESTORE OK attempt={attempt}: folder_bytes={} folder_utf16={} round_trip=passed reopen=passed",
                    folder.len(),
                    folder.encode_utf16().count()
                );
            }
        }
    }
    interface_lang::set(previous).unwrap();
}
