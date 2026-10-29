//! Internal, transaction-consistent provider facts for the application workspace.
//! Queries use the same SQL condition interpreter as Library::browse.
use super::{BrowseScope, ContentRating, Error, Library, filter, rating};
use crate::search::ConditionTree;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProviderImage {
    pub id: String,
    pub sha256: String,
    pub seq: i64,
    pub width: u32,
    pub height: u32,
    /// 有效分级（#223）：是否被封印由工作区按当前的安全模式范围判断，快照不随范围变。
    #[serde(default)]
    pub rating: Option<ContentRating>,
    /// 旧版本缓存的“含成人内容”（那时范围固定为敏感及以上），只在读旧缓存时用。
    /// 旧缓存分不出敏感和成人，按成人算，所以范围选“仅成人”时宁可多遮。
    #[serde(default, rename = "adult", skip_serializing)]
    pub legacy_adult: bool,
    pub deleted: bool,
    #[serde(skip)]
    pub tags: Vec<String>,
    #[serde(skip)]
    pub folders: Vec<String>,
}
impl ProviderImage {
    /// 有效分级；旧缓存只知道是否含成人内容，按最严的一档（成人）算，任何范围下都遮蔽、不会漏出。
    pub(crate) fn effective_rating(&self) -> Option<ContentRating> {
        self.rating
            .or(self.legacy_adult.then_some(ContentRating::Explicit))
    }
}

pub(crate) struct ProviderSnapshot {
    pub list_revision: i64,
    pub vocabulary_revision: i64,
    pub images: Vec<ProviderImage>,
}
impl Library {
    pub(crate) fn provider_revision(&self) -> Result<(i64, i64), Error> {
        Ok(self.inner.readers.get().query_row(
            "SELECT (SELECT value FROM list_revision),(SELECT value FROM vocabulary_revision)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }
    pub(crate) fn provider_matches(
        &self,
        scope: &BrowseScope,
        tree: &ConditionTree,
    ) -> Result<std::collections::BTreeSet<String>, Error> {
        let mut args = Vec::new();
        let conn = self.inner.readers.get();
        let scope = super::types::scope_sql(&conn, scope, &mut args)?;
        let conditions = filter::sql(tree, &mut args);
        let mut stmt = conn.prepare(&format!(
            "SELECT id FROM image WHERE ({scope}) AND ({conditions})"
        ))?;
        Ok(stmt
            .query_map(params_from_iter(&args), |r| r.get(0))?
            .collect::<Result<_, _>>()?)
    }

    /// 这些原图（按 SHA-256）已生成的占位图（#313），一条查询读出；还没有的不在结果里。
    pub(crate) fn placeholders(
        &self,
        shas: &[&str],
    ) -> Result<std::collections::HashMap<String, String>, Error> {
        super::thumbnail::placeholders(&self.inner.readers.get(), &self.inner.root, shas)
    }

    pub(crate) fn provider_snapshot(&self) -> Result<ProviderSnapshot, Error> {
        let mut conn = self.inner.readers.get();
        let tx = conn.transaction()?;
        let list_revision = tx.query_row("SELECT value FROM list_revision", [], |r| r.get(0))?;
        let vocabulary_revision =
            tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?;
        let mut images = {
            let mut stmt = tx.prepare(&format!(
                "SELECT id,sha256,seq,width,height,{},deleted_at IS NOT NULL FROM image ORDER BY seq DESC",
                rating::effective_rank_sql("image.id")))?;
            stmt.query_map([], |r| {
                Ok(ProviderImage {
                    id: r.get(0)?,
                    sha256: r.get(1)?,
                    seq: r.get(2)?,
                    width: r.get(3)?,
                    height: r.get(4)?,
                    rating: r
                        .get::<_, Option<i64>>(5)?
                        .and_then(ContentRating::from_rank),
                    legacy_adult: false,
                    deleted: r.get(6)?,
                    tags: Vec::new(),
                    folders: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        let mut tags = std::collections::HashMap::<String, Vec<String>>::new();
        {
            let mut stmt = tx.prepare("SELECT image_id,tag_id FROM effective_tag")?;
            for row in
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (image, tag) = row?;
                tags.entry(image).or_default().push(tag);
            }
        }
        let mut folders = std::collections::HashMap::<String, Vec<String>>::new();
        {
            let mut stmt = tx.prepare("SELECT image_id,folder_id FROM folder_member")?;
            for row in
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (image, folder) = row?;
                folders.entry(image).or_default().push(folder);
            }
        }
        for image in &mut images {
            image.tags = tags.remove(&image.id).unwrap_or_default();
            image.folders = folders.remove(&image.id).unwrap_or_default();
        }
        tx.finish()?;
        Ok(ProviderSnapshot {
            list_revision,
            vocabulary_revision,
            images,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::SafeModeScope;

    #[test]
    fn an_old_cache_entry_marked_adult_is_sealed_under_every_scope() {
        let image: ProviderImage = serde_json::from_str(
            r#"{"id":"i","sha256":"s","seq":1,"width":1,"height":1,"adult":true,"deleted":false}"#,
        )
        .unwrap();
        for scope in [
            SafeModeScope::Sensitive,
            SafeModeScope::Questionable,
            SafeModeScope::Explicit,
        ] {
            assert!(image.effective_rating().is_some_and(|r| scope.covers(r)));
        }
    }
}
