-- 永久删除（#67）。

-- 回收站修订号：回收站里有哪些图变化时加一（移进、恢复、永久删除、导入时直接进回收站）。
-- 永久删除预览给出的令牌绑定它，执行时不一致就要求重新预览。用触发器维护，任何写入路径都不会漏。
CREATE TABLE trash_revision (
    only  INTEGER PRIMARY KEY CHECK (only = 1),
    value INTEGER NOT NULL
);
INSERT INTO trash_revision (only, value) VALUES (1, 0);

CREATE TRIGGER trash_revision_insert AFTER INSERT ON image
    WHEN new.deleted_at IS NOT NULL
BEGIN
    UPDATE trash_revision SET value = value + 1;
END;

CREATE TRIGGER trash_revision_update AFTER UPDATE OF deleted_at ON image
    WHEN old.deleted_at IS NOT new.deleted_at
BEGIN
    UPDATE trash_revision SET value = value + 1;
END;

CREATE TRIGGER trash_revision_delete AFTER DELETE ON image
BEGIN
    UPDATE trash_revision SET value = value + 1;
END;

-- 待清除的原文件：与删除参考图记录同一个事务写入；提交后删文件、再删这条记录。
-- 中途崩溃时，下次打开资料库接着清（文件已被新导入的参考图或进行中的导入使用时只删记录）。
CREATE TABLE original_removal (
    rel_path TEXT PRIMARY KEY,
    sha256   TEXT NOT NULL
);
