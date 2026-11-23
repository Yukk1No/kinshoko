use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use rusqlite::backup::{Backup, StepResult};

use super::{
    DB_FILE, Error, Library, LibrarySnapshot, OriginalsLease, checked_info, curation, originals,
    store,
};
use crate::library::fault;

pub(crate) enum SnapshotError {
    Source(Error),
    WriteCopy(Error),
    ReadCopy(Error),
}

impl Library {
    /// 取得原文件租约，再用 SQLite Online Backup 把数据库一致地快照到 `into` 下，依赖清单与整理信息
    /// 摘要都按快照读出。`into` 不存在时建立。
    pub fn snapshot_at(
        root: &Path,
        expected_id: &str,
        into: &Path,
    ) -> Result<LibrarySnapshot, Error> {
        Self::snapshot_for_backup(root, expected_id, into).map_err(|error| match error {
            SnapshotError::Source(e) | SnapshotError::WriteCopy(e) | SnapshotError::ReadCopy(e) => {
                e
            }
        })
    }

    pub(crate) fn snapshot_for_backup(
        root: &Path,
        expected_id: &str,
        into: &Path,
    ) -> Result<LibrarySnapshot, SnapshotError> {
        let library = checked_info(root, expected_id).map_err(SnapshotError::Source)?;
        let lease = OriginalsLease::take(&library.id);
        let source = store::inspect_db(&root.join(DB_FILE)).map_err(SnapshotError::Source)?;
        let database = into.join(DB_FILE);
        write_copy(source, into, &database).map_err(SnapshotError::WriteCopy)?;
        let conn = store::inspect_db(&database).map_err(SnapshotError::ReadCopy)?;
        Ok(LibrarySnapshot {
            originals: originals(&conn, &library.root).map_err(SnapshotError::ReadCopy)?,
            curation: curation(&conn, None).map_err(SnapshotError::ReadCopy)?,
            database,
            library,
            _lease: lease,
        })
    }
}

fn write_copy(source: Connection, into: &Path, database: &Path) -> Result<(), Error> {
    std::fs::create_dir_all(into)?;
    let mut copy = Connection::open(store::sqlite_path(database)?)?;
    // 一步复制全部页：整个复制期间持有同一个读事务，得到一致的快照。
    let backup = Backup::new(&source, &mut copy)?;
    fault::storage("backup_database_copy")?;
    loop {
        match backup.step(-1)? {
            StepResult::Done => break,
            StepResult::More => {}
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    drop(backup);
    // 快照是一个自足的文件，不带 -wal。
    copy.pragma_update(None, "journal_mode", "DELETE")?;
    Ok(())
}
