-- Content carries the definition needed to interpret each local identity.
-- This table is part of the ordinary SQLite content snapshot, never a dependency on an app path.
CREATE TABLE tag_definition_dependency (
    local_tag_id TEXT PRIMARY KEY REFERENCES tag(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    definition TEXT NOT NULL,
    authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1))
);
CREATE INDEX tag_definition_by_identity ON tag_definition_dependency(catalog_id);

CREATE TABLE tag_definition_dirty (local_tag_id TEXT PRIMARY KEY REFERENCES tag(id) ON DELETE CASCADE);
INSERT INTO tag_definition_dirty SELECT id FROM tag;
CREATE TRIGGER portable_tag_insert AFTER INSERT ON tag BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.id); END;
CREATE TRIGGER portable_tag_update AFTER UPDATE ON tag BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.id); END;
CREATE TRIGGER portable_tag_name_insert AFTER INSERT ON tag_name BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.tag_id); END;
CREATE TRIGGER portable_tag_name_update AFTER UPDATE ON tag_name BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.tag_id); END;
CREATE TRIGGER portable_tag_name_delete AFTER DELETE ON tag_name BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (OLD.tag_id); END;
CREATE TRIGGER portable_tag_alias_insert AFTER INSERT ON tag_alias BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.tag_id); END;
CREATE TRIGGER portable_tag_alias_update AFTER UPDATE ON tag_alias BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.tag_id); END;
CREATE TRIGGER portable_tag_alias_delete AFTER DELETE ON tag_alias BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (OLD.tag_id); END;
CREATE TRIGGER portable_tag_external_insert AFTER INSERT ON tag_external BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.tag_id); END;
CREATE TRIGGER portable_tag_external_update AFTER UPDATE ON tag_external BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (NEW.tag_id); END;
CREATE TRIGGER portable_tag_external_delete AFTER DELETE ON tag_external BEGIN INSERT OR IGNORE INTO tag_definition_dirty(local_tag_id) VALUES (OLD.tag_id); END;
