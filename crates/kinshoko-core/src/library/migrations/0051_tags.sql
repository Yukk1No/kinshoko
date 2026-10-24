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
