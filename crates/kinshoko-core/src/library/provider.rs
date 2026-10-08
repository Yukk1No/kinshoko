//! Internal, transaction-consistent provider facts for the application workspace.
//! Queries use the same SQL condition interpreter as Library::browse.
use super::{BrowseScope, Error, Library, filter, rating};
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
    pub adult: bool,
    pub deleted: bool,
    #[serde(skip)]
    pub tags: Vec<String>,
    #[serde(skip)]
    pub folders: Vec<String>,
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

    pub(crate) fn provider_snapshot(&self) -> Result<ProviderSnapshot, Error> {
        let mut conn = self.inner.readers.get();
        let tx = conn.transaction()?;
        let list_revision = tx.query_row("SELECT value FROM list_revision", [], |r| r.get(0))?;
        let vocabulary_revision =
            tx.query_row("SELECT value FROM vocabulary_revision", [], |r| r.get(0))?;
        let mut images = {
            let mut stmt = tx.prepare(&format!(
                "SELECT id,sha256,seq,width,height,{},deleted_at IS NOT NULL FROM image ORDER BY seq DESC",
                rating::adult_sql("image.id")))?;
            stmt.query_map([], |r| {
                Ok(ProviderImage {
                    id: r.get(0)?,
                    sha256: r.get(1)?,
                    seq: r.get(2)?,
                    width: r.get(3)?,
                    height: r.get(4)?,
                    adult: r.get(5)?,
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
