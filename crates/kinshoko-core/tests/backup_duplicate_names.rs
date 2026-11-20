#[path = "support/backup_device.rs"]
mod backup_device;

use std::collections::BTreeSet;
use std::sync::mpsc;
use std::time::Duration;

use backup_device::{at, target};
use kinshoko_core::backup::{BackupSources, ScopeSelection, compute_scope};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary};

#[test]
fn same_name_libraries_restore_after_a_single_library_restore() {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let temp = tempfile::tempdir().unwrap();
        let libraries: Vec<_> = (0..3)
            .map(|i| Library::create(&temp.path().join(format!("source-{i}")), "Shared").unwrap())
            .collect();
        let registry: Vec<_> = libraries
            .iter()
            .map(|library| RegisteredLibrary {
                id: library.info().id.clone(),
                name: library.info().name.clone(),
                root: library.info().root.clone(),
            })
            .collect();
        let groups = ReferenceGroups::open(&temp.path().join("groups")).unwrap();
        let backup = target(temp.path());
        let sources = BackupSources {
            libraries: &registry,
            groups: &groups,
        };
        let save = |selection, stamp| {
            let scope = compute_scope(&registry, &[], &selection);
            backup.run(&scope, &sources, stamp, &mut |_| {}).unwrap()
        };
        let single = save(
            ScopeSelection::Libraries {
                ids: vec![registry[0].id.clone()],
                include_linked: false,
            },
            at(-1, 1),
        );
        let all = save(ScopeSelection::All, at(0, 2));
        for previous_count in [0, 3, 1] {
            let into = temp.path().join(format!("restore-{previous_count}"));
            let previous = if previous_count == 0 {
                Vec::new()
            } else {
                backup
                    .restore(
                        if previous_count == 1 {
                            &single.snapshot_id
                        } else {
                            &all.snapshot_id
                        },
                        &into,
                        &groups,
                        at(0, 3),
                    )
                    .unwrap()
                    .libraries
            };
            for library in &previous {
                std::fs::write(library.library.root.join("sentinel"), b"untouched").unwrap();
            }
            let restored = backup
                .restore(&all.snapshot_id, &into, &groups, at(0, 4))
                .unwrap();
            assert!(restored.check.passed(), "{:?}", restored.check);
            assert_eq!(restored.libraries.len(), 3);
            let roots: BTreeSet<_> = restored
                .libraries
                .iter()
                .map(|library| library.library.root.clone())
                .collect();
            assert_eq!(roots.len(), 3);
            assert!(roots.iter().all(|root| root.is_dir()));
            for library in previous {
                assert!(!roots.contains(&library.library.root));
                assert_eq!(
                    std::fs::read(library.library.root.join("sentinel")).unwrap(),
                    b"untouched"
                );
                assert_eq!(
                    Library::inspect(&library.library.root).unwrap().id,
                    library.library.id
                );
            }
        }
        send.send(()).unwrap();
    });
    receive
        .recv_timeout(Duration::from_secs(10))
        .expect("restoring three same-name libraries must complete without looping");
}
