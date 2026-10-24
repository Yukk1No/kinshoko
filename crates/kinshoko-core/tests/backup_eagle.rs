//! #8 的“备份恢复”检查按 Eagle 1.8.x 与 4.x 的 fixture 各跑一遍（#69）：迁入的来源原样 JSON、
//! 区域评论、文件夹、标签与本库整理在备份恢复后逐项一致，原文件 SHA-256 不变。

#[path = "support/eagle.rs"]
#[allow(dead_code)]
mod eagle;

use kinshoko_core::backup::{BackupSources, BackupTarget, ScopeSelection, Stamp, compute_scope};
use kinshoko_core::library::{ImageEdit, ImportSource};
use kinshoko_core::reference_groups::ReferenceGroups;
use kinshoko_core::{Library, RegisteredLibrary};
use sha2::{Digest, Sha256};

#[test]
fn an_eagle_migrated_library_round_trips_through_backup_and_restore() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 4);
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();
        library.set_safe_mode(false);
        library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();
        let sources = library.eagle_sources().unwrap();
        let first = sources[0].bindings[0].image_id.clone();
        library
            .edit(
                std::slice::from_ref(&first),
                &[
                    ImageEdit::SetNote {
                        text: "本库备注".into(),
                    },
                    ImageEdit::Delete,
                ],
            )
            .unwrap();

        let registry = [RegisteredLibrary {
            id: library.info().id.clone(),
            name: library.info().name.clone(),
            root: library.info().root.clone(),
        }];
        let groups = ReferenceGroups::open(&dir.path().join("reference-groups")).unwrap();
        let scope = compute_scope(&registry, &groups.list().unwrap(), &ScopeSelection::All);
        std::fs::create_dir_all(dir.path().join("移动盘")).unwrap();
        let target = BackupTarget::new(&dir.path().join("移动盘"));
        let at = Stamp::new(1_791_158_400_000, 480);
        let report = target
            .run(
                &scope,
                &BackupSources {
                    libraries: &registry,
                    groups: &groups,
                },
                at,
                &mut |_| {},
            )
            .unwrap();
        assert!(report.complete, "{version}: {:?}", report.problems);

        let restored = target
            .restore(&report.snapshot_id, &dir.path().join("恢复"), &groups, at)
            .unwrap();
        assert!(restored.check.passed(), "{version}: {:?}", restored.check);
        let copy = Library::open(&restored.libraries[0].library.root).unwrap();
        copy.set_safe_mode(false);
        assert_eq!(copy.eagle_sources().unwrap(), sources, "{version}");
        for binding in &sources[0].bindings {
            let id = &binding.image_id;
            assert_eq!(copy.image(id).unwrap(), library.image(id).unwrap());
            let sha = |l: &Library| {
                format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(l.original_to_tag(id).unwrap()).unwrap())
                )
            };
            assert_eq!(sha(&copy), sha(&library), "原文件 SHA-256 不变");
        }
        assert!(copy.image(&first).unwrap().deleted_at.is_some());
    }
}
