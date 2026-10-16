-- Eagle 重导与按来源分层（#58）。

-- 内容变化后的新版本指向旧版本；旧版本连同它的整理保留。
ALTER TABLE image ADD COLUMN previous_image_id TEXT REFERENCES image(id);
CREATE INDEX image_previous ON image(previous_image_id);

-- 画师确认 Eagle 资料库搬了家后，记下原来的位置。
ALTER TABLE import_source ADD COLUMN relocated_from TEXT;
