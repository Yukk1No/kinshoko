-- #87: directory structure changes affect the workspace forest and descendant scopes.
CREATE TRIGGER list_revision_folder_insert AFTER INSERT ON folder
BEGIN
    UPDATE list_revision SET value = value + 1;
END;
CREATE TRIGGER list_revision_folder_update AFTER UPDATE OF name, parent_id, ord ON folder
WHEN OLD.name IS NOT NEW.name OR OLD.parent_id IS NOT NEW.parent_id OR OLD.ord IS NOT NEW.ord
BEGIN
    UPDATE list_revision SET value = value + 1;
END;
CREATE TRIGGER list_revision_folder_delete AFTER DELETE ON folder
BEGIN
    UPDATE list_revision SET value = value + 1;
END;
