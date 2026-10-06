-- 人工分级（#53）：画师修正的内容分级，优先于各来源的分级建议，重新打标不覆盖。
-- NULL 表示画师没有修正（或已退回自动分级）。有效分级只在 rating.rs 的 effective_rank_sql 定义。
ALTER TABLE image ADD COLUMN rating_manual TEXT
    CHECK (rating_manual IN ('general', 'sensitive', 'questionable', 'explicit'));
