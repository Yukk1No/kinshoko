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
