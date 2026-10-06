//! Eagle 首次迁入（#57）：只通过核心 crate 的公开接口验证，源库始终只读。

#[path = "support/eagle.rs"]
mod eagle;

use kinshoko_core::Library;
use kinshoko_core::library::{ImportOutcome, ImportSource};
use sha2::{Digest, Sha256};

#[test]
fn first_import_reads_items_not_thumbnails_or_mtime_and_preserves_original_bytes() {
    for version in ["1.8.2", "4.0.0"] {
        let dir = tempfile::tempdir().unwrap();
        let fixture = eagle::build(&dir.path().join("主库.library"), version, 1);
        let original = std::fs::read(fixture.original(0)).unwrap();
        let metadata = std::fs::read(fixture.item_dir(0).join("metadata.json")).unwrap();
        let library = Library::create(&dir.path().join("kinshoko"), "参考").unwrap();

        let report = library
            .import(ImportSource {
                paths: vec![fixture.root.clone()],
            })
            .wait();

        assert_eq!(report.items.len(), 1, "只枚举 images 下的条目：{report:?}");
        let ImportOutcome::Imported { image_id } = &report.items[0].outcome else {
            panic!("Eagle {version} 应成功迁入：{report:?}");
        };
        assert_eq!(
            Sha256::digest(std::fs::read(library.original_path(image_id).unwrap()).unwrap()),
            Sha256::digest(&original)
        );
        assert_eq!(std::fs::read(fixture.original(0)).unwrap(), original);
        assert_eq!(
            std::fs::read(fixture.item_dir(0).join("metadata.json")).unwrap(),
            metadata
        );
    }
}
