//! 资料库的 SQLite 存储：迁移、单写线程与读连接池（#8 验证过的格式）。
//!
//! 写入只经过 [`Writer`] 的专属线程顺序执行，每个任务是一个短事务；
//! 文件 I/O 与哈希在调用方的线程里先做完，不进事务。

use std::path::Path;
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;

use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

use super::Error;

/// 只追加，不改已发布的迁移。
fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("migrations/0001_library.sql")),
        M::up(include_str!("migrations/0051_tags.sql")),
        M::up(include_str!("migrations/0046_import_pending.sql")),
        // 文件名按工单编号；执行顺序按合入先后（#51、#46 先于 #50 合入），只往后追加。
        M::up(include_str!("migrations/0050_folders_notes_trash.sql")),
        M::up(include_str!("migrations/0052_tagging.sql")),
        M::up(include_str!("migrations/0057_eagle_import.sql")),
        M::up(include_str!("migrations/0057_eagle_initial_trash.sql")),
    ])
}

pub(super) const DB_FILE: &str = "library.sqlite";

/// SQLite 不会自己处理超过 260 个字符的 Windows 路径；换成 `\\?\` 形式的绝对路径交给它。
/// 标准库的文件操作已经会自动这样做。
fn sqlite_path(path: &Path) -> Result<std::path::PathBuf, Error> {
    let path = std::path::absolute(path)?;
    if cfg!(windows) {
        let s = path.to_string_lossy();
        if !s.starts_with(r"\\") {
            return Ok(format!(r"\\?\{s}").into());
        }
        if let Some(unc) = s.strip_prefix(r"\\").filter(|r| !r.starts_with(['?', '.'])) {
            return Ok(format!(r"\\?\UNC\{unc}").into());
        }
    }
    Ok(path)
}

fn connect(path: &Path) -> Result<Connection, Error> {
    let conn = Connection::open(sqlite_path(path)?)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// 打开（必要时升级）数据库。比本程序新的数据库版本会被拒绝。
pub(super) fn open_db(path: &Path) -> Result<Connection, Error> {
    let mut conn = connect(path)?;
    migrations().to_latest(&mut conn)?;
    Ok(conn)
}

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

/// 独占写连接的线程。任务按提交顺序执行。
pub(super) struct Writer {
    tx: Option<mpsc::Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Writer {
    pub(super) fn spawn(mut conn: Connection) -> Writer {
        let (tx, rx) = mpsc::channel::<Job>();
        let thread = std::thread::Builder::new()
            .name("kinshoko-library-writer".into())
            .spawn(move || {
                for job in rx {
                    job(&mut conn);
                }
            })
            .expect("无法启动资料库写线程");
        Writer {
            tx: Some(tx),
            thread: Some(thread),
        }
    }

    /// 在写线程上执行 `f` 并等待结果。
    pub(super) fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> T + Send + 'static,
    ) -> T {
        let (reply, result) = mpsc::sync_channel(1);
        let job: Job = Box::new(move |conn| {
            let _ = reply.send(f(conn));
        });
        self.tx
            .as_ref()
            .expect("写线程已关闭")
            .send(job)
            .expect("写线程已退出");
        result.recv().expect("写线程在任务中退出")
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 只读连接池。读不经过写线程，WAL 下与写入并发。
pub(super) struct Readers {
    pool: Vec<Mutex<Connection>>,
}

impl Readers {
    pub(super) fn open(path: &Path, size: usize) -> Result<Readers, Error> {
        let pool = (0..size.max(1))
            .map(|_| {
                let conn = connect(path)?;
                conn.pragma_update(None, "query_only", "ON")?;
                super::filter::register(&conn)?;
                Ok(Mutex::new(conn))
            })
            .collect::<Result<_, Error>>()?;
        Ok(Readers { pool })
    }

    pub(super) fn get(&self) -> MutexGuard<'_, Connection> {
        for slot in &self.pool {
            if let Ok(conn) = slot.try_lock() {
                return conn;
            }
        }
        self.pool[0].lock().unwrap_or_else(|e| e.into_inner())
    }
}
