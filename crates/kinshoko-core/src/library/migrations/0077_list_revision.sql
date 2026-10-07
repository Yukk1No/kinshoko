-- 列表修订号（#77 S4）：浏览结果集的成员可能变化时加一，用于让旧的分页游标失效。
-- 由触发器维护，任何写入路径都不会漏掉：参考图的增删、回收站、文件夹成员、备注（文字条件
-- 会匹配它）与人工分级（可能跨过“含成人内容”）。来源分级跨过成人线时由 rating.rs 另行加一；
-- 只影响条件查找的有效标签变化看词表修订号（vocabulary_revision）。
CREATE TABLE list_revision (
    only  INTEGER PRIMARY KEY CHECK (only = 1),
    value INTEGER NOT NULL
);
INSERT INTO list_revision (only, value) VALUES (1, 0);

CREATE TRIGGER list_revision_image_insert AFTER INSERT ON image
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_image_delete AFTER DELETE ON image
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_image_update
AFTER UPDATE OF deleted_at, note_manual, rating_manual ON image
WHEN OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.note_manual IS NOT NEW.note_manual
  OR OLD.rating_manual IS NOT NEW.rating_manual
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_member_insert AFTER INSERT ON folder_member
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_member_delete AFTER DELETE ON folder_member
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_source_insert AFTER INSERT ON image_source
WHEN NEW.note IS NOT NULL
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_source_delete AFTER DELETE ON image_source
WHEN OLD.note IS NOT NULL
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER list_revision_source_note AFTER UPDATE OF note ON image_source
WHEN OLD.note IS NOT NEW.note
BEGIN
    UPDATE list_revision SET value = value + 1;
END;
