-- 画师在本库作出的文件夹放入/移出决定（#77 C2）。Eagle 重导只改画师没决定过的归属。
-- 已有库里看不出过去哪些归属是画师决定的，迁移时不补记；决定从升级后开始记录。
CREATE TABLE folder_decision (
    folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
    image_id  TEXT NOT NULL REFERENCES image(id) ON DELETE CASCADE,
    -- 1：画师放入；0：画师移出。
    member    INTEGER NOT NULL CHECK (member IN (0, 1)),
    PRIMARY KEY (folder_id, image_id)
);
