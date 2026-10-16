-- 恢复来源（#69、#8 的格式约束）：这个资料库是从哪个备份快照、哪个原资料库恢复出来的。
-- 恢复出的库有新的资料库身份；再次备份、恢复时追加一行，不改旧行。
CREATE TABLE restore_provenance (
    old_library_id TEXT NOT NULL,
    backup_id      TEXT NOT NULL,
    restored_at    INTEGER NOT NULL
);
