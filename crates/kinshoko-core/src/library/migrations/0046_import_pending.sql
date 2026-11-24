-- 导入的 pending 记录（#46）：原文件发布前写入，与参考图同一个事务结束。
-- 打开资料库时剩下的记录都是中断的导入项，按它撤回暂存与已发布但未提交的原文件。

CREATE TABLE import_pending (
    id            TEXT PRIMARY KEY,
    -- 预期内容。
    sha256        TEXT NOT NULL,
    size          INTEGER NOT NULL,
    -- 相对资料库根目录的暂存文件与发布目标。
    staging_path  TEXT NOT NULL,
    rel_path      TEXT NOT NULL,
    -- 写入 pending 时发布目标已经存在：撤回时不删除它。
    target_existed INTEGER NOT NULL,
    -- 原图所在位置，撤回后列给画师重试。
    location      TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);
