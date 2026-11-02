-- pixiv 收藏夹（#371）：列出过的收藏。收藏夹按收藏先后排，不看发布时间；检查时从最近的收藏往前翻，
-- 翻到列出过的就停，比它近的才是新收藏。feed 是哪条收藏流（0 公开、1 非公开）。
CREATE TABLE listed_work (
    subscription_id TEXT NOT NULL,
    work_id         TEXT NOT NULL,
    feed            INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, work_id)
);
CREATE INDEX listed_work_feed ON listed_work (subscription_id, feed);
-- 最近若干张数到的最后一个作品只收前几页：记下页数，重试时也不多收。
CREATE TABLE page_limit (
    subscription_id TEXT NOT NULL,
    work_id         TEXT NOT NULL,
    pages           INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, work_id)
);
-- 已有的非公开收藏收多少（JSON，见 subscription::Backlog）；为空时同 backlog。只有收藏夹有。
ALTER TABLE subscription ADD COLUMN private_backlog TEXT;
