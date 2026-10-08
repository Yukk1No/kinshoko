-- 文件夹、备注与可恢复删除（#50）。时间一律为 Unix 毫秒。

-- 文件夹树。ord 是同一父文件夹下的显示顺序，从 0 连续编号。
CREATE TABLE folder (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT REFERENCES folder(id),
    ord        INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX folder_parent ON folder(parent_id, ord);

-- 画师把参考图放进文件夹。一张图可以在多个文件夹里。
CREATE TABLE folder_member (
    folder_id TEXT NOT NULL REFERENCES folder(id),
    image_id  TEXT NOT NULL REFERENCES image(id),
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (folder_id, image_id)
);
CREATE INDEX folder_member_image ON folder_member(image_id);

-- 画师写的备注；NULL 表示没有写，显示来源提供的备注。空字符串是画师清空了备注。
ALTER TABLE image ADD COLUMN note_manual TEXT;
-- 可恢复删除的时间；NULL 表示未删除。
ALTER TABLE image ADD COLUMN deleted_at INTEGER;
CREATE INDEX image_deleted ON image(deleted_at, seq);

-- 来源提供的备注（例如 Eagle 的整图备注），按来源分层写入；普通文件导入没有备注。
ALTER TABLE image_source ADD COLUMN note TEXT;
