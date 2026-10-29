//! 打开资料库时在后台补齐占位图，并清掉 #313 之前存成文件的占位图（从 `thumbnail.rs` 原样移出）。

use std::path::Path;
use std::sync::Weak;

use super::{
    CACHE_DIR, Inner, PIPELINE, PLACEHOLDER, PlaceholderSource, SDR, THUMBS_DIR,
    insert_placeholders, load_placeholder,
};

/// 后台补齐时每攒这么多张写一次库。
const FILL_BATCH: usize = 32;

/// 为缺少占位图（或只有旧管线版本的）参考图补齐，从新到旧（先补最可能在眼前的）。在后台线程里
/// 调用。之前存成文件的读进来，写进库后删掉文件；没有的现场生成。
/// 只持有弱引用：资料库关闭后在下一批之前停下，不让数据库连接活得比资料库久。
/// 失败只是这张图继续退回中性底色，下次打开再试。
pub(in crate::library) fn fill_placeholders(inner: Weak<Inner>) {
    let started = std::time::Instant::now();
    let (root, sources) = {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let conn = inner.readers.get();
        let sources = conn
            .prepare(
                "SELECT sha256, rel_path, width, height FROM image
                 WHERE sha256 NOT IN (SELECT sha256 FROM placeholder WHERE pipeline = ?1)
                 GROUP BY sha256 ORDER BY MAX(seq) DESC",
            )
            .and_then(|mut stmt| {
                stmt.query_map([PIPELINE], |row| {
                    Ok(PlaceholderSource {
                        sha: row.get(0)?,
                        rel_path: row.get(1)?,
                        width: row.get(2)?,
                        height: row.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
            });
        match sources {
            Ok(sources) => (inner.root.clone(), sources),
            Err(_) => return,
        }
    };
    crate::diagnostics::took("占位图补齐：查缺", started, Some(sources.len()));
    let mut failed = 0;
    for batch in sources.chunks(FILL_BATCH) {
        let mut rows = Vec::new();
        let mut files = Vec::new();
        for source in batch {
            if inner.strong_count() == 0 {
                return;
            }
            match load_placeholder(&root, source) {
                Ok((row, file)) => {
                    rows.push(row);
                    files.extend(file);
                }
                Err(_) => failed += 1,
            }
        }
        let Some(inner) = inner.upgrade() else {
            return;
        };
        if inner
            .writer
            .run(move |conn| insert_placeholders(conn, &rows))
            .is_err()
        {
            return;
        }
        for file in files {
            let _ = std::fs::remove_file(file);
        }
    }
    if !sources.is_empty() {
        crate::diagnostics::took("占位图补齐：完成", started, Some(sources.len()));
    }
    if failed > 0 {
        crate::diagnostics::took("占位图补齐：失败张数", started, Some(failed));
    }
    sweep_placeholder_files(&inner, &root);
}

/// 迁移 0313 留下的标记还在时，删掉缓存目录里剩下的占位图文件，再删掉标记。补齐已经把它们读进
/// 表里（expand 过渡期同时存的文件，表里本来就有，补齐不会再碰）；万一有没读进去的，表里没有，
/// 下次打开补齐现场生成。补齐中途停下（资料库关了）时不扫，留到下次。有目录读不出或文件删不掉
/// （例如别的程序正开着它）时标记留着，下次打开再扫；本来就不在的算删掉了。
/// 扫目录时不握着资料库：Windows 上握着时资料库文件夹改不了名。
fn sweep_placeholder_files(inner: &Weak<Inner>, root: &Path) {
    let pending = {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        inner.readers.get().query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master
                            WHERE type = 'table' AND name = 'placeholder_files_pending')",
            [],
            |r| r.get::<_, bool>(0),
        )
    };
    if !matches!(pending, Ok(true)) {
        return;
    }
    let gone = |result: std::io::Result<()>| match result {
        Ok(()) => true,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    };
    let sdr = root
        .join(CACHE_DIR)
        .join(THUMBS_DIR)
        .join(PIPELINE)
        .join(SDR);
    let swept = (|| -> std::io::Result<bool> {
        let mut all = true;
        let dirs = match std::fs::read_dir(sdr) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            dirs => dirs?,
        };
        for dir in dirs {
            let dir = dir?.path();
            if !dir.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                if entry
                    .file_name()
                    .to_string_lossy()
                    .contains(&format!("-{PLACEHOLDER}."))
                {
                    all &= gone(std::fs::remove_file(entry.path()));
                }
            }
        }
        Ok(all)
    })();
    if matches!(swept, Ok(true))
        && let Some(inner) = inner.upgrade()
    {
        let _ = inner
            .writer
            .run(|conn| conn.execute_batch("DROP TABLE placeholder_files_pending;"));
    }
}
