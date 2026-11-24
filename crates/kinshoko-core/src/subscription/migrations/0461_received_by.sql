-- 一条订阅收过哪些作品（不论收进哪个库）：改了收进的库以后，靠它不把改之前收过的作品再收进新库，
-- 也用来数画师卡片上收过几张图（#461）。
CREATE INDEX received_work_by_subscription ON received_work (subscription_id, source, work_id);
