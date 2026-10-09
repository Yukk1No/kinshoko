-- Frozen released library schema from 536cc43c1933e44fc33836f8a439de8cdb0da018, version 16.
-- Fixture construction only; behavior assertions use public Library/TagCatalog actions.

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

-- 标签与人工标签决定（#51，ADR-0003）。时间一律为 Unix 毫秒。

-- 标签身份是库内稳定的 id；命名空间是身份的一部分。
CREATE TABLE tag (
    id         TEXT PRIMARY KEY,
    namespace  TEXT NOT NULL CHECK (namespace IN ('general', 'artist', 'character', 'work')),
    created_at INTEGER NOT NULL
);

-- 按语言保存的标签名，属于画师的整理数据。没有任何名称的标签显示外部名称并标明尚未翻译。
CREATE TABLE tag_name (
    tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    lang   TEXT NOT NULL,
    name   TEXT NOT NULL,
    PRIMARY KEY (tag_id, lang)
);
CREATE INDEX tag_name_by_name ON tag_name(name);

-- 标签别名；lang 为空表示不区分语言。
CREATE TABLE tag_alias (
    tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    name   TEXT NOT NULL,
    lang   TEXT,
    PRIMARY KEY (tag_id, name)
);
CREATE INDEX tag_alias_by_name ON tag_alias(name);

-- 外部对应：外部词表中的名称（如打标模型输出的 blue_eyes）。一个外部名称只落在一个标签上。
CREATE TABLE tag_external (
    name   TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE
);
CREATE INDEX tag_external_by_tag ON tag_external(tag_id);

-- 按来源分层的标签事实。某个来源重写时只替换 source 相同的行。
CREATE TABLE tag_fact (
    image_id TEXT NOT NULL REFERENCES image(id),
    tag_id   TEXT NOT NULL REFERENCES tag(id),
    source   TEXT NOT NULL,
    score    REAL,
    PRIMARY KEY (image_id, tag_id, source)
);
CREATE INDEX tag_fact_by_tag ON tag_fact(tag_id);

-- 人工标签决定。来源重写从不碰这张表。
-- 'conflict' 是合并资料库时未解决的标签决定冲突，有效值保留“添加”（合并向导在 roadmap）。
CREATE TABLE tag_decision (
    image_id   TEXT NOT NULL REFERENCES image(id),
    tag_id     TEXT NOT NULL REFERENCES tag(id),
    decision   TEXT NOT NULL CHECK (decision IN ('add', 'reject', 'conflict')),
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (image_id, tag_id)
);
CREATE INDEX tag_decision_by_tag ON tag_decision(tag_id);

-- 有效标签：未解决冲突保留添加 > 人工标签决定 > 各来源事实的并集。
CREATE VIEW effective_tag AS
    SELECT f.image_id, f.tag_id FROM tag_fact f
    WHERE NOT EXISTS (
        SELECT 1 FROM tag_decision d
        WHERE d.image_id = f.image_id AND d.tag_id = f.tag_id AND d.decision = 'reject')
    UNION
    SELECT image_id, tag_id FROM tag_decision WHERE decision IN ('add', 'conflict');

-- 标签分组：为显示整理的一组标签，不影响查找。namespace 不为空时，成员是该命名空间的全部标签。
CREATE TABLE tag_group (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    namespace  TEXT CHECK (namespace IN ('general', 'artist', 'character', 'work')),
    ord        INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE tag_group_member (
    group_id TEXT NOT NULL REFERENCES tag_group(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    ord      INTEGER NOT NULL,
    PRIMARY KEY (group_id, tag_id)
);

-- 词表修订号：标签、名称、别名、外部对应、分组或有效标签变化时加一，供 Search 缓存词表快照。
CREATE TABLE vocabulary_revision (
    only  INTEGER PRIMARY KEY CHECK (only = 1),
    value INTEGER NOT NULL
);
INSERT INTO vocabulary_revision (only, value) VALUES (1, 0);

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

-- 个人近似对应表（#56，ADR-0003）：画师在本资料库中对相近标签的判断，按标签身份记录。
-- 一对标签无方向，只记一条（写入时先删掉两种顺序的旧记录）；tag_a、tag_b 保留画师记下时的顺序，
-- 供资料库设置中列出。与内置近似对应表冲突时以这里为准；内置表更新不改动这张表。
CREATE TABLE personal_approx (
    tag_a      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    tag_b      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    relation   TEXT NOT NULL CHECK (relation IN ('similar', 'notSimilar')),
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (tag_a, tag_b),
    CHECK (tag_a <> tag_b)
);
CREATE INDEX personal_approx_by_b ON personal_approx(tag_b);

-- 人工分级（#53）：画师修正的内容分级，优先于各来源的分级建议，重新打标不覆盖。
-- NULL 表示画师没有修正（或已退回自动分级）。有效分级只在 rating.rs 的 effective_rank_sql 定义。
ALTER TABLE image ADD COLUMN rating_manual TEXT
    CHECK (rating_manual IN ('general', 'sensitive', 'questionable', 'explicit'));

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

-- Eagle 首次迁入（#57）。来源只读；未知字段保留在原样 JSON 中。
ALTER TABLE image ADD COLUMN collected_at INTEGER;
UPDATE image SET collected_at = imported_at;
ALTER TABLE image_source ADD COLUMN url TEXT;

CREATE TABLE import_source (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'eagle'),
    location TEXT NOT NULL UNIQUE,
    raw_library_json TEXT NOT NULL,
    mapping_version INTEGER NOT NULL,
    registered_at INTEGER NOT NULL
);

CREATE TABLE eagle_folder (
    source_id TEXT NOT NULL REFERENCES import_source(id),
    external_id TEXT NOT NULL,
    folder_id TEXT NOT NULL UNIQUE REFERENCES folder(id),
    PRIMARY KEY (source_id, external_id)
);

CREATE TABLE source_binding (
    source_id TEXT NOT NULL REFERENCES import_source(id),
    external_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    image_id TEXT NOT NULL REFERENCES image(id),
    raw_item_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('present', 'trashed', 'missing', 'superseded')),
    collected_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, external_id, sha256)
);
CREATE INDEX source_binding_image ON source_binding(image_id);

-- 坐标基准未经核验；首版只保存与往返，不显示坐标。
CREATE TABLE region_note (
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    ord INTEGER NOT NULL,
    basis TEXT NOT NULL CHECK (basis = 'eagle-raw-unverified'),
    raw_json TEXT NOT NULL,
    PRIMARY KEY (source_id, external_id, sha256, ord),
    FOREIGN KEY (source_id, external_id, sha256)
        REFERENCES source_binding(source_id, external_id, sha256)
);

-- 区分首次 Eagle 迁入的删除状态与画师的删除决定，供新重复条目合并时使用。
-- 不推断旧记录的删除来源，避免覆盖已有的人工决定。
ALTER TABLE image ADD COLUMN eagle_initial_trash INTEGER NOT NULL DEFAULT 0
    CHECK (eagle_initial_trash IN (0, 1));

-- Eagle 重导与按来源分层（#58）。

-- 内容变化后的新版本指向旧版本；旧版本连同它的整理保留。
ALTER TABLE image ADD COLUMN previous_image_id TEXT REFERENCES image(id);
CREATE INDEX image_previous ON image(previous_image_id);

-- 画师确认 Eagle 资料库搬了家后，记下原来的位置。
ALTER TABLE import_source ADD COLUMN relocated_from TEXT;

-- 画师在本库作出的文件夹放入/移出决定（#77 C2）。Eagle 重导只改画师没决定过的归属。
-- 已有库里看不出过去哪些归属是画师决定的，迁移时不补记；决定从升级后开始记录。
CREATE TABLE folder_decision (
    folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
    image_id  TEXT NOT NULL REFERENCES image(id) ON DELETE CASCADE,
    -- 1：画师放入；0：画师移出。
    member    INTEGER NOT NULL CHECK (member IN (0, 1)),
    PRIMARY KEY (folder_id, image_id)
);

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

-- 参考组包导入记录（#68，imported_from_package）。时间一律为 Unix 毫秒。
-- 包里每张图以 `package:<包 id>` 来源分层写入标签、分级、备注与来源链接（image_source / tag_fact /
-- rating_fact），这里记下包本身：导出它的参考组、导出时间与导入位置。重复导入同一个包只更新这一行。
CREATE TABLE package_import (
    package_id  TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL,
    group_name  TEXT NOT NULL,
    exported_at INTEGER NOT NULL,
    location    TEXT NOT NULL,
    imported_at INTEGER NOT NULL
);

-- 恢复来源（#69、#8 的格式约束）：这个资料库是从哪个备份快照、哪个原资料库恢复出来的。
-- 恢复出的库有新的资料库身份；再次备份、恢复时追加一行，不改旧行。
CREATE TABLE restore_provenance (
    old_library_id TEXT NOT NULL,
    backup_id      TEXT NOT NULL,
    restored_at    INTEGER NOT NULL
);

PRAGMA user_version=16;
