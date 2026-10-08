-- 资料库格式 v1：身份、参考图与来源（#44）。
-- 时间一律为 Unix 毫秒。原文件位置相对资料库根目录。

CREATE TABLE library (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);

-- seq 决定浏览顺序与 keyset 游标；id 是对外的参考图身份。
CREATE TABLE image (
    seq           INTEGER PRIMARY KEY,
    id            TEXT NOT NULL UNIQUE,
    sha256        TEXT NOT NULL UNIQUE,
    size          INTEGER NOT NULL,
    format        TEXT NOT NULL,
    rel_path      TEXT NOT NULL,
    -- 已按 EXIF 方向转正的显示尺寸。
    width         INTEGER NOT NULL,
    height        INTEGER NOT NULL,
    orientation   INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    imported_at   INTEGER NOT NULL
);

-- 每条参考图的来源。按来源分层写入时，各来源只替换自己的记录。
CREATE TABLE image_source (
    image_id    TEXT NOT NULL REFERENCES image(id),
    source      TEXT NOT NULL,
    location    TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (image_id, source, location)
);
