-- 区分首次 Eagle 迁入的删除状态与画师的删除决定，供新重复条目合并时使用。
-- 不推断旧记录的删除来源，避免覆盖已有的人工决定。
ALTER TABLE image ADD COLUMN eagle_initial_trash INTEGER NOT NULL DEFAULT 0
    CHECK (eagle_initial_trash IN (0, 1));
