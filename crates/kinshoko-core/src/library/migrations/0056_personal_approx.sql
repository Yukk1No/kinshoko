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
