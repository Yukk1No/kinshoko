-- 人工分级（#53）：画师修正的内容分级，优先于各来源的分级建议，重新打标不覆盖。
-- NULL 表示画师没有修正（或已退回自动分级）。
ALTER TABLE image ADD COLUMN rating_manual TEXT
    CHECK (rating_manual IN ('general', 'sensitive', 'questionable', 'explicit'));

-- 有效分级：人工分级优先，否则取各来源建议中最严格的一档；都没有时为 NULL。
-- 浏览视角的过滤（安全模式 #60）可以直接用这个视图。
CREATE VIEW effective_rating AS
SELECT i.id AS image_id,
       COALESCE(i.rating_manual, (
           SELECT f.rating FROM rating_fact f WHERE f.image_id = i.id
           ORDER BY CASE f.rating
               WHEN 'explicit' THEN 3 WHEN 'questionable' THEN 2
               WHEN 'sensitive' THEN 1 ELSE 0 END DESC
           LIMIT 1)) AS rating
FROM image i;
