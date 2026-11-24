-- 图集（#418）按来源层与来源链接现算：来源链接变了，图片墙上的叠放可能跟着变，列表修订号加一，
-- 工作区快照随之重读。订阅的来源层总带链接，也由这几条覆盖。
CREATE TRIGGER IF NOT EXISTS list_revision_source_url_insert AFTER INSERT ON image_source
WHEN NEW.url IS NOT NULL
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER IF NOT EXISTS list_revision_source_url_delete AFTER DELETE ON image_source
WHEN OLD.url IS NOT NULL
BEGIN
    UPDATE list_revision SET value = value + 1;
END;

CREATE TRIGGER IF NOT EXISTS list_revision_source_url AFTER UPDATE OF url ON image_source
WHEN OLD.url IS NOT NEW.url
BEGIN
    UPDATE list_revision SET value = value + 1;
END;
