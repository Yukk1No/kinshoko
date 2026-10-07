//! 参考图色彩描述的读写（`image_colour` 表）。

use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::{Error, Inner};
use crate::fidelity::inspect::inspect;
use crate::fidelity::{Cicp, ColourDescription, IccSummary};

fn to_text<T: Serialize>(v: T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        other => unreachable!("枚举序列化为字符串：{other:?}"),
    }
}

fn from_text<T: DeserializeOwned>(s: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
    })
}

/// 写入（或替换）一张参考图的色彩描述。在调用方的事务里执行。
pub(super) fn record(
    conn: &rusqlite::Connection,
    image_id: &str,
    d: &ColourDescription,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO image_colour (image_id, format, bit_depth, colour_model,
             declaration, icc_sha256, icc_version, icc_kind, cicp, alpha, orientation, hdr,
             hdr_metadata, animated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            image_id,
            d.format,
            d.bit_depth,
            to_text(d.colour_model),
            to_text(d.declaration),
            d.icc.as_ref().map(|i| &i.sha256),
            d.icc.as_ref().map(|i| &i.version),
            d.icc.as_ref().map(|i| to_text(i.kind)),
            d.cicp.map(|c| format!(
                "{}/{}/{}/{}",
                c.primaries, c.transfer, c.matrix, c.full_range as u8
            )),
            d.alpha,
            d.orientation,
            d.hdr.map(to_text),
            d.hdr_metadata,
            d.animated,
        ],
    )?;
    Ok(())
}

fn from_row(row: &Row) -> rusqlite::Result<ColourDescription> {
    let icc_sha256: Option<String> = row.get("icc_sha256")?;
    let icc = match icc_sha256 {
        None => None,
        Some(sha256) => Some(IccSummary {
            sha256,
            version: row.get("icc_version")?,
            kind: from_text(row.get("icc_kind")?)?,
        }),
    };
    let cicp: Option<String> = row.get("cicp")?;
    let cicp = cicp.and_then(|s| {
        let v: Vec<u8> = s.split('/').filter_map(|p| p.parse().ok()).collect();
        match v[..] {
            [primaries, transfer, matrix, full_range] => Some(Cicp {
                primaries,
                transfer,
                matrix,
                full_range: full_range != 0,
            }),
            _ => None,
        }
    });
    Ok(ColourDescription {
        format: row.get("format")?,
        bit_depth: row.get("bit_depth")?,
        colour_model: from_text(row.get("colour_model")?)?,
        declaration: from_text(row.get("declaration")?)?,
        icc,
        cicp,
        alpha: row.get("alpha")?,
        orientation: row.get("orientation")?,
        hdr: row
            .get::<_, Option<String>>("hdr")?
            .map(from_text)
            .transpose()?,
        hdr_metadata: row.get("hdr_metadata")?,
        animated: row.get("animated")?,
    })
}

/// 参考图的色彩描述及其原文件位置。早于 #45 导入、还没有描述的参考图在这里按原文件补记。
pub(super) fn get(
    inner: &Inner,
    image_id: &str,
) -> Result<(ColourDescription, String, std::path::PathBuf), Error> {
    let (sha, rel_path, recorded): (String, String, Option<ColourDescription>) = {
        let conn = inner.readers.get();
        let (sha, rel_path): (String, String) = conn
            .query_row(
                "SELECT sha256, rel_path FROM image WHERE id = ?1",
                [image_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(Error::UnknownImage)?;
        let recorded = conn
            .query_row(
                "SELECT * FROM image_colour WHERE image_id = ?1",
                [image_id],
                from_row,
            )
            .optional()?;
        (sha, rel_path, recorded)
    };
    let path = inner.root.join(&rel_path);
    if let Some(d) = recorded {
        return Ok((d, sha, path));
    }
    let bytes = std::fs::read(&path)?;
    let description = inspect(&bytes)
        .map_err(Error::Undecodable)?
        .ok_or_else(|| Error::Undecodable("不支持的格式".into()))?
        .description;
    let (id, d) = (image_id.to_owned(), description.clone());
    // 补记是可重建的缓存：只读打开的资料库（参考组读取未激活的库，#66）记不下也照常显示。
    if let Err(e) = inner.writer.run(move |conn| record(conn, &id, &d))
        && !inner.detached
    {
        return Err(e.into());
    }
    Ok((description, sha, path))
}
