#[path = "support/backup_device.rs"]
mod backup_device;

use backup_device::{at, target};
use kinshoko_core::backup::{BackupSources, ScopeSelection, compute_scope};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary, interface_lang};

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
                assert!(folder.len() <= 255, "{folder}");
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
