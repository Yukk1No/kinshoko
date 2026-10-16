-- #78 T14：永久删除记忆属于目标资料库，按内容版本（原图 SHA-256）保存。
-- 与移除 image/source_binding 同一事务写入；明确允许某次重导不移除记忆。
CREATE TABLE eagle_deleted_content (
    sha256 TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
);
