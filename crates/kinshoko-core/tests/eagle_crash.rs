//! Eagle 与普通文件共用 #46 的故障注入接缝；原图和所有来源事实一起提交或撤回。

#[path = "support/eagle.rs"]
mod eagle;

use std::path::PathBuf;
use std::process::Command;

use kinshoko_core::Library;
use kinshoko_core::library::{ImportOutcome, ImportSource};

#[test]
#[ignore = "只在故障注入子进程里运行"]
fn child_imports_eagle_until_fault() {
    let library = Library::open(&PathBuf::from(
        std::env::var_os("KINSHOKO_TEST_LIBRARY").unwrap(),
    ))
    .unwrap();
    library
        .import(ImportSource {
            paths: vec![PathBuf::from(
                std::env::var_os("KINSHOKO_TEST_EAGLE").unwrap(),
            )],
        })
        .wait();
    panic!("没有在注入点崩溃");
}

#[test]
fn interruption_never_publishes_partial_eagle_metadata_and_retry_is_idempotent() {
    for version in ["1.8.2", "4.0.0"] {
        for point in [
            "import_after_staging",
            "import_after_pending",
            "import_after_publish",
            "import_before_commit",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let fixture = eagle::build(&dir.path().join("主库.library"), version, 6);
            let root = dir.path().join("kinshoko");
            drop(Library::create(&root, "参考").unwrap());
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "child_imports_eagle_until_fault",
                    "--test-threads=1",
                ])
                .env("KINSHOKO_FAULT", format!("{point}@4"))
                .env("KINSHOKO_TEST_LIBRARY", &root)
                .env("KINSHOKO_TEST_EAGLE", &fixture.root)
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(99), "{version} {point}");
            let library = Library::open(&root).unwrap();
            let source = &library.eagle_sources().unwrap()[0];
            assert_eq!(source.bindings.len(), 3, "{version} {point}");
            assert!(source.bindings.iter().all(|b| b.region_notes.is_empty()));
            assert_eq!(library.sidebar().unwrap().all, 3);
            assert!(
                library
                    .vocabulary()
                    .unwrap()
                    .tags
                    .iter()
                    .all(|t| t.names.iter().all(|n| n.name != "标签3"))
            );
            assert!(library.recovery().orphans.is_empty());
            let interrupted = if point == "import_after_staging" {
                vec![]
            } else {
                vec![std::path::absolute(fixture.item_dir(3)).unwrap()]
            };
            assert_eq!(library.recovery().interrupted, interrupted);
            assert_eq!(
                std::fs::read(library.original_path(&source.bindings[0].image_id).unwrap())
                    .unwrap(),
                std::fs::read(fixture.original(0)).unwrap()
            );
            let retry = library
                .import(ImportSource {
                    paths: vec![fixture.root.clone()],
                })
                .wait();
            assert_eq!(retry.items.len(), 6);
            assert!(
                retry.items[..3]
                    .iter()
                    .all(|i| matches!(i.outcome, ImportOutcome::Merged { .. }))
            );
            assert!(
                retry.items[3..]
                    .iter()
                    .all(|i| matches!(i.outcome, ImportOutcome::Imported { .. })),
                "{version} {point}: {retry:?}"
            );
            let source = &library.eagle_sources().unwrap()[0];
            assert_eq!(source.bindings.len(), 6);
            assert_eq!(source.bindings[3].region_notes.len(), 1);
            assert_eq!(library.sidebar().unwrap().all, 5);
            assert_eq!(library.sidebar().unwrap().trash, 1);
            drop(library);
            assert!(
                Library::open(&root)
                    .unwrap()
                    .recovery()
                    .interrupted
                    .is_empty()
            );
        }
    }
}
