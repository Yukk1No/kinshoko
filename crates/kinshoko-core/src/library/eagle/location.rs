//! Eagle 库搬家后的位置确认。

use super::*;
use crate::CommandError;

/// 新位置疑似已登记来源搬了家：某个来源已绑定的条目至少一半出现在这里。只提议，不写任何数据。
pub(super) fn relocation(
    inner: &Inner,
    root: &Path,
    present: &[String],
) -> Result<Option<EagleRelocation>, CommandError> {
    let present: HashSet<&str> = present.iter().map(String::as_str).collect();
    let conn = inner.readers.get();
    let mut stmt = conn
        .prepare_cached(
            "SELECT DISTINCT s.id, s.location, b.external_id
             FROM import_source s JOIN source_binding b ON b.source_id = s.id",
        )
        .map_err(CommandError::system)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(CommandError::system)?;
    // 来源 → (登记位置, 已绑定条目数, 出现在新位置的条目数)
    let mut sources: HashMap<String, (String, u64, u64)> = HashMap::new();
    for row in rows {
        let (id, location, external_id) = row.map_err(CommandError::system)?;
        let entry = sources.entry(id).or_insert((location, 0, 0));
        entry.1 += 1;
        entry.2 += u64::from(present.contains(external_id.as_str()));
    }
    let best = sources
        .into_iter()
        .filter(|(_, (_, bound, seen))| seen * 2 >= *bound)
        .max_by(|a, b| {
            (a.1.2 * b.1.1)
                .cmp(&(b.1.2 * a.1.1))
                .then_with(|| b.0.cmp(&a.0))
        });
    Ok(match best {
        Some((source_id, (from, bound, seen))) => Some(EagleRelocation {
            source_id,
            from: PathBuf::from(from),
            to: PathBuf::from(canonical(root)?),
            overlap_percent: (seen * 100 / bound) as u32,
        }),
        None => None,
    })
}

/// 去掉 Windows 规范路径的 `\\?\` 前缀，与导入时记下的条目位置同形。
pub(super) fn plain(location: &str) -> PathBuf {
    if let Some(rest) = location.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else {
        PathBuf::from(location.strip_prefix(r"\\?\").unwrap_or(location))
    }
}

/// 两个路径写法是否指同一位置。Windows 的路径不区分大小写，分隔符可写成 `/` 或 `\`。
pub(super) fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        let fold = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
        fold(a) == fold(b)
    } else {
        a == b
    }
}

/// 画师确认疑似搬家的位置。
pub(in crate::library) fn confirm_location(
    inner: &Inner,
    path: &Path,
    choice: EagleLocationChoice,
) -> Result<(), Error> {
    let invalid = |reason: CommandError| {
        Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, reason))
    };
    let location = canonical(path).map_err(invalid)?;
    match choice {
        EagleLocationChoice::Separate => {
            register_new(inner, path).map_err(invalid)?;
            Ok(())
        }
        EagleLocationChoice::Moved { source_id } => {
            inner.write(move |tx| {
                let old: String = tx
                    .query_row(
                        "SELECT location FROM import_source WHERE id = ?1",
                        [&source_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .ok_or(Error::UnknownEagleSource)?;
                if old == location {
                    return Ok(());
                }
                if tx
                    .query_row(
                        "SELECT 1 FROM import_source WHERE location = ?1",
                        [&location],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Err(Error::EagleLocationTaken);
                }
                tx.execute(
                    "UPDATE import_source SET location = ?2, relocated_from = ?3 WHERE id = ?1",
                    params![source_id, location, old],
                )?;
                // 来源记录跟着搬家，重导时刷新同一行而不是多出一行。按绑定的条目找记录，
                // 路径比较不受写法影响：首次导入的写法可能与登记的规范路径大小写不同。
                let (old_root, new_root) = (plain(&old), plain(&location));
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT b.image_id, b.external_id, s.location
                     FROM source_binding b
                     JOIN image_source s ON s.image_id = b.image_id AND s.source = 'eagle'
                     WHERE b.source_id = ?1",
                )?;
                let rows: Vec<(String, String, String)> = stmt
                    .query_map([&source_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
                for (image_id, external_id, at) in rows {
                    let entry = format!("{external_id}.info");
                    if !same_path(Path::new(&at), Path::new(&item_location(&old_root, entry.as_ref()))) {
                        continue;
                    }
                    let to = item_location(&new_root, entry.as_ref());
                    // 新位置已有同一条目的记录（例如搬家前已经重导过）：旧记录并入它。
                    let moved = tx.execute(
                        "UPDATE OR IGNORE image_source SET location = ?3
                         WHERE image_id = ?1 AND source = 'eagle' AND location = ?2",
                        params![image_id, at, to],
                    )?;
                    if moved == 0 {
                        tx.execute(
                            "DELETE FROM image_source WHERE image_id = ?1 AND source = 'eagle' AND location = ?2",
                            params![image_id, at],
                        )?;
                    }
                }
                Ok(())
            })
        }
    }
}
