use super::*;

#[test]
fn an_unavailable_selected_library_preserves_the_same_day_restore_point() {
    let device = Device::new();
    let target = target(device.dir.path());
    let registry = device.registry();
    let selection = ScopeSelection::Libraries {
        ids: vec![device.main.info().id.clone()],
        include_linked: false,
    };
    let scope = compute_scope(&registry, &[], &selection);
    let sources = BackupSources {
        libraries: &registry,
        groups: &device.groups,
    };
    let good = target.run(&scope, &sources, at(0, 3), &mut |_| {}).unwrap();
    assert!(good.complete);
    assert_eq!(good.copied, 3);

    drop(device.main);
    std::fs::rename(&registry[0].root, device.dir.path().join("离线")).unwrap();
    let report = target.run(&scope, &sources, at(0, 4), &mut |_| {}).unwrap();
    let snapshots = target.snapshots().unwrap();
    assert!(
        !report.complete
            && report.removed_snapshots.is_empty()
            && snapshots.len() == 1
            && snapshots[0].id == good.snapshot_id,
        "failed backup must not publish or prune: {report:?}, snapshots: {snapshots:?}"
    );
    assert!(!report.problems.is_empty());
    let restored = target
        .restore(
            &good.snapshot_id,
            &device.dir.path().join("恢复"),
            &device.groups,
            at(1, 1),
        )
        .unwrap();
    assert!(restored.check.passed(), "{:?}", restored.check);
    assert_eq!(restored.check.originals.checked, good.copied);
}

#[test]
fn a_partial_same_day_backup_preserves_the_offline_librarys_restore_point() {
    let device = Device::new();
    let target = target(device.dir.path());
    let registry = device.registry();
    let scope = compute_scope(&registry, &[], &ScopeSelection::All);
    let sources = BackupSources {
        libraries: &registry,
        groups: &device.groups,
    };
    let good = target.run(&scope, &sources, at(0, 3), &mut |_| {}).unwrap();
    assert!(good.complete);

    drop(device.old);
    std::fs::rename(&registry[1].root, device.dir.path().join("离线")).unwrap();
    let added = import(&device.main, &device.dir.path().join("later"), &[29]);
    let partial = target.run(&scope, &sources, at(0, 4), &mut |_| {}).unwrap();
    assert!(
        partial.complete,
        "readable library must be backed up: {partial:?}"
    );
    assert!(partial.problems.is_empty());
    assert_eq!(partial.skipped.len(), 1);
    assert_eq!(partial.skipped[0].library.id, registry[1].id);
    assert!(partial.removed_snapshots.is_empty(), "{partial:?}");

    let latest = target
        .restore(
            &partial.snapshot_id,
            &device.dir.path().join("新快照"),
            &device.groups,
            at(1, 1),
        )
        .unwrap();
    assert!(latest.check.passed(), "{:?}", latest.check);
    assert_eq!(latest.libraries.len(), 1);
    assert_eq!(latest.libraries[0].old_id, registry[0].id);
    let online = Library::open(&latest.libraries[0].library.root).unwrap();
    assert_eq!(
        online.image(&added[0]).unwrap(),
        device.main.image(&added[0]).unwrap()
    );

    let previous = target
        .restore(
            &good.snapshot_id,
            &device.dir.path().join("旧快照"),
            &device.groups,
            at(1, 2),
        )
        .unwrap();
    assert!(previous.check.passed(), "{:?}", previous.check);
    let offline = previous
        .libraries
        .iter()
        .find(|l| l.old_id == registry[1].id)
        .unwrap();
    let offline = Library::open(&offline.library.root).unwrap();
    for id in &device.old_images {
        assert!(offline.original_path(id).unwrap().is_file());
    }
}
