-- 自动标签与内容分级（#52）。时间一律为 Unix 毫秒。

-- 按来源分层的内容分级建议（目前只有模型来源）。同一来源重写只替换自己那一行。
CREATE TABLE rating_fact (
    image_id TEXT NOT NULL REFERENCES image(id),
    source   TEXT NOT NULL,
    rating   TEXT NOT NULL CHECK (rating IN ('general', 'sensitive', 'questionable', 'explicit')),
    score    REAL,
    PRIMARY KEY (image_id, source)
);

-- 每个模型来源对每张参考图的打标进度：done 已写入建议；failed 这张图无法打标（附原因），不再重试。
-- 没有行的图就是这个来源待打标的图。
CREATE TABLE tagging_state (
    image_id TEXT NOT NULL REFERENCES image(id),
    source   TEXT NOT NULL,
    status   TEXT NOT NULL CHECK (status IN ('done', 'failed')),
    reason   TEXT,
    at       INTEGER NOT NULL,
    PRIMARY KEY (image_id, source)
);
CREATE INDEX tagging_state_by_source ON tagging_state(source);
