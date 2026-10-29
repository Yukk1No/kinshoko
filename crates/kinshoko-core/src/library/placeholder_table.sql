-- 占位图（#110）存进资料库（#313）：每张原图（按字节的 SHA-256）一条，浏览一页一条查询读出。
-- `pipeline` 是生成它的缩略图管线版本，与当前版本不同的不再使用，后台补齐时换掉。
-- 过渡期间占位图仍同时存成 `cache/thumbs/.../<sha>-p32.<webp|png>` 文件，表里没有的从文件读。
CREATE TABLE IF NOT EXISTS placeholder (
    sha256 TEXT PRIMARY KEY,
    pipeline TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL
) WITHOUT ROWID;
