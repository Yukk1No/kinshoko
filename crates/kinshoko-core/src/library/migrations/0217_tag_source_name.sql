-- #217（ADR-0012）：导入来源为标签带来的叫法是本库的来源名称，不再记成简体中文名称。
-- lang 为 'und' 表示未注明语言。重新迁入时跟随来源；画师改过的语言保留。
CREATE TABLE IF NOT EXISTS tag_source_name (
    tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    name   TEXT NOT NULL,
    lang   TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (tag_id, name)
);
CREATE INDEX IF NOT EXISTS tag_source_name_by_name ON tag_source_name(name);
-- 并掉的标签去了哪个标签：统一标签目录同步时把旧标签的名称偏好、分组等移给它。
CREATE TABLE IF NOT EXISTS tag_merge (
    from_tag TEXT PRIMARY KEY,
    to_tag   TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE
);
-- 已迁入过 Eagle 的资料库由迁移钩子把 Eagle 原文从名称改为来源名称或别名。
