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
