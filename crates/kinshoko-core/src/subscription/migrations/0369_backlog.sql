-- 订阅画师（#369）：订阅时旧作收多少（JSON，见 subscription::Backlog），以及由它定下的
-- “发布时间早于 since 的作品不收”。#368 时还没有添加订阅的地方，已有的行按全部收。
ALTER TABLE subscription ADD COLUMN backlog TEXT NOT NULL DEFAULT '{"kind":"all"}';
ALTER TABLE subscription ADD COLUMN since INTEGER;
