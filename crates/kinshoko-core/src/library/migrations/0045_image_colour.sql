-- 参考图的色彩描述（#45、ADR-0005）：导入时按文件内容记录，以后据此只重建受影响的派生图。
-- 早于本迁移导入的参考图没有这一行，第一次需要时按原文件补记。

CREATE TABLE image_colour (
    image_id     TEXT PRIMARY KEY REFERENCES image(id),
    -- jpeg / png / webp / gif
    format       TEXT NOT NULL,
    bit_depth    INTEGER NOT NULL,
    -- rgb / gray / cmyk
    colour_model TEXT NOT NULL,
    -- 实际生效的色彩声明：none / icc / cicp / srgb / gammaChromaticities / gamma
    declaration  TEXT NOT NULL,
    -- 文件里嵌入的 ICC（可能因颜色模型不符被忽略）。
    icc_sha256   TEXT,
    icc_version  TEXT,
    -- matrix / lut / gray / invalid
    icc_kind     TEXT,
    -- PNG cICP 或 ICC cicp 标签："原色/传递函数/矩阵系数/全范围(0|1)"
    cicp         TEXT,
    alpha        INTEGER NOT NULL,
    -- EXIF 方向 1～8（与 image.orientation 相同）
    orientation  INTEGER NOT NULL,
    -- pq / hlg / gainMap
    hdr          TEXT,
    hdr_metadata INTEGER NOT NULL,
    animated     INTEGER NOT NULL
);
