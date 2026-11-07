-- 订阅（#368）。时间一律为 Unix 毫秒。
-- 订阅名单由 Kinshoko 自己维护；target 是订阅来源里的对象（JSON，见 subscription::Target）。
CREATE TABLE subscription (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    target          TEXT NOT NULL,
    name            TEXT NOT NULL,
    library_id      TEXT NOT NULL,
    include_explicit INTEGER NOT NULL DEFAULT 1,
    include_manga   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_error      TEXT,
    -- 上次检查没完成的时间：出错后隔一段时间再试，不连续重查。
    last_failed_at  INTEGER
);

-- 已收作品：每个资料库、每个来源作品一行。收过的（包括后来被删掉的）不再下载；
-- 跳过的（动图）也记下，订阅记录里标明“已跳过”。
CREATE TABLE received_work (
    library_id      TEXT NOT NULL,
    source          TEXT NOT NULL,
    work_id         TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    explicit        INTEGER NOT NULL,
    received_at     INTEGER NOT NULL,
    seen            INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (library_id, source, work_id)
);
CREATE INDEX received_work_recent ON received_work (received_at DESC);

-- 已收的页：多页作品中途中断时，下次只补没收的页。
CREATE TABLE received_page (
    library_id  TEXT NOT NULL,
    source      TEXT NOT NULL,
    work_id     TEXT NOT NULL,
    page        INTEGER NOT NULL,
    image_id    TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (library_id, source, work_id, page)
);

-- 没收成的作品（下载或导入失败）：下次检查时来源不能在比它新的已收作品处停止翻页，
-- 否则它永远轮不到重试。失败太多次的放弃。
CREATE TABLE failed_work (
    subscription_id TEXT NOT NULL,
    source          TEXT NOT NULL,
    work_id         TEXT NOT NULL,
    attempts        INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, source, work_id)
);

-- 遇到频率限制后的退避：到 until 之前不检查；level 每连续一次加一。
CREATE TABLE backoff (
    source TEXT PRIMARY KEY,
    until  INTEGER NOT NULL,
    level  INTEGER NOT NULL
);
