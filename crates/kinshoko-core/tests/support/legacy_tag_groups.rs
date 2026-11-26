//! 测试用：把库内遗留标签分组直接写入 SQLite。`Library` 不再公开分组改写动作；
//! 这些行模拟旧版本资料库留给统一标签目录迁移的数据。

#![allow(dead_code)]

use kinshoko_core::Library;
use kinshoko_core::library::TagNamespace;
use rusqlite::{TransactionBehavior, params};

/// 按旧版本的写入形状加一个分组，返回分组 id；`members` 按给出的顺序排列。
pub fn insert_tag_group(
    library: &Library,
    name: &str,
    namespace: Option<TagNamespace>,
    members: &[String],
) -> String {
    let id = uuid::Uuid::now_v7().simple().to_string();
    let namespace = namespace.map(|namespace| match namespace {
        TagNamespace::General => "general",
        TagNamespace::Artist => "artist",
        TagNamespace::Character => "character",
        TagNamespace::Work => "work",
    });
    let mut conn = rusqlite::Connection::open(library.info().root.join("library.sqlite")).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    tx.execute(
        "INSERT INTO tag_group (id, name, namespace, ord, created_at)
         VALUES (?1, ?2, ?3, (SELECT coalesce(max(ord), -1) + 1 FROM tag_group), 1000)",
        params![id, name, namespace],
    )
    .unwrap();
    for (ord, member) in members.iter().enumerate() {
        tx.execute(
            "INSERT INTO tag_group_member (group_id, tag_id, ord) VALUES (?1, ?2, ?3)",
            params![id, member, ord as i64],
        )
        .unwrap();
    }
    tx.execute("UPDATE vocabulary_revision SET value = value + 1", [])
        .unwrap();
    tx.commit().unwrap();
    id
}
