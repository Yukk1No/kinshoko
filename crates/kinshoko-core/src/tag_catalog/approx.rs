//! Application-wide personal rules; local Library rows are retained as migration provenance.
use super::*;
use crate::approx::{ApproxRelation, PersonalApprox, ordered};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxSource {
    pub library_id: String,
    pub library_name: String,
    pub library_root: String,
    pub rule: PersonalApprox,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxMigration {
    pub source: CatalogApproxSource,
    pub a: String,
    pub b: String,
    pub confirmed: bool,
}
/// Null explicit decisions remember deletion/ignore; automatic rows can be withdrawn by a conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxDecision {
    pub a: String,
    pub b: String,
    pub relation: Option<ApproxRelation>,
    pub explicit: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxOrigin {
    pub library_id: String,
    pub library_name: String,
    pub library_root: String,
    pub relation: ApproxRelation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxEntry {
    pub a: TagLabel,
    pub b: TagLabel,
    pub relation: ApproxRelation,
    pub sources: Vec<CatalogApproxOrigin>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxConflict {
    pub a: TagLabel,
    pub b: TagLabel,
    pub current: Option<ApproxRelation>,
    pub sources: Vec<CatalogApproxOrigin>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApproxView {
    #[ts(type = "number")]
    pub revision: i64,
    pub entries: Vec<CatalogApproxEntry>,
    pub conflicts: Vec<CatalogApproxConflict>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CatalogApproxEdit {
    Set {
        rules: Vec<PersonalApprox>,
    },
    Remove {
        a: String,
        b: String,
    },
    ResolveConflict {
        a: String,
        b: String,
        #[ts(type = "number")]
        revision: i64,
        relation: Option<ApproxRelation>,
    },
}

pub(super) fn initialize(conn: &Connection) -> Result<(), CatalogError> {
    conn.execute_batch(
        "BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS catalog_approx (
            a TEXT NOT NULL REFERENCES catalog_tag(id), b TEXT NOT NULL REFERENCES catalog_tag(id),
            relation TEXT, explicit INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL,
            PRIMARY KEY(a,b));
        CREATE TABLE IF NOT EXISTS catalog_approx_migration (
            library_id TEXT NOT NULL, local_a TEXT NOT NULL, local_b TEXT NOT NULL,
            source TEXT NOT NULL, a TEXT NOT NULL REFERENCES catalog_tag(id),
            b TEXT NOT NULL REFERENCES catalog_tag(id), confirmed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(library_id,local_a,local_b));
        PRAGMA user_version=5; COMMIT;",
    )?;
    Ok(())
}

pub(super) fn migrate(
    tx: &Transaction<'_>,
    library: &Library,
    rules: &[PersonalApprox],
) -> Result<bool, CatalogError> {
    let mut changed = false;
    for rule in rules {
        let (local_a, local_b) = ordered(rule.a.clone(), rule.b.clone());
        if tx.query_row("SELECT 1 FROM catalog_approx_migration WHERE library_id=?1 AND local_a=?2 AND local_b=?3", params![library.info().id,local_a,local_b], |_| Ok(())).optional()?.is_some() { continue; }
        let mapped = |id: &str| -> Result<Option<String>, CatalogError> {
            Ok(tx.query_row("SELECT catalog_id FROM library_tag_mapping WHERE library_id=?1 AND local_tag_id=?2", params![library.info().id,id], |r| r.get(0)).optional()?)
        };
        let (Some(a), Some(b)) = (mapped(&rule.a)?, mapped(&rule.b)?) else {
            continue;
        };
        if a == b {
            continue;
        }
        let (a, b) = ordered(a, b);
        let source = CatalogApproxSource {
            library_id: library.info().id.clone(),
            library_name: library.info().name.clone(),
            library_root: library.info().root.to_string_lossy().into_owned(),
            rule: rule.clone(),
        };
        let prior: Option<Option<String>> = tx
            .query_row(
                "SELECT relation FROM catalog_approx WHERE a=?1 AND b=?2 AND explicit=1",
                params![a, b],
                |r| r.get(0),
            )
            .optional()?;
        let confirmed = prior
            .flatten()
            .map(|text| serde_json::from_str::<ApproxRelation>(&text))
            .transpose()?
            .is_some_and(|relation| relation == rule.relation);
        tx.execute("INSERT INTO catalog_approx_migration(library_id,local_a,local_b,source,a,b,confirmed) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![library.info().id,local_a,local_b,serde_json::to_string(&source)?,a,b,confirmed])?;
        reconcile(tx, &a, &b)?;
        changed = true;
    }
    Ok(changed)
}
fn reconcile(tx: &Transaction<'_>, a: &str, b: &str) -> Result<(), CatalogError> {
    if tx
        .query_row(
            "SELECT 1 FROM catalog_approx WHERE a=?1 AND b=?2 AND explicit=1",
            params![a, b],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    let mut stmt = tx.prepare("SELECT source FROM catalog_approx_migration WHERE a=?1 AND b=?2")?;
    let sources = stmt
        .query_map(params![a, b], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut similar = false;
    let mut not_similar = false;
    for source in sources {
        match serde_json::from_str::<CatalogApproxSource>(&source)?
            .rule
            .relation
        {
            ApproxRelation::Similar => similar = true,
            ApproxRelation::NotSimilar => not_similar = true,
        }
    }
    if similar && not_similar {
        tx.execute(
            "DELETE FROM catalog_approx WHERE a=?1 AND b=?2 AND explicit=0",
            params![a, b],
        )?;
    } else {
        let relation = if similar {
            ApproxRelation::Similar
        } else {
            ApproxRelation::NotSimilar
        };
        tx.execute("INSERT INTO catalog_approx(a,b,relation,explicit,ord) VALUES (?1,?2,?3,0,(SELECT coalesce(max(ord),-1)+1 FROM catalog_approx)) ON CONFLICT(a,b) DO UPDATE SET relation=excluded.relation", params![a,b,serde_json::to_string(&relation)?])?;
    }
    Ok(())
}
fn decisions(conn: &Connection) -> Result<Vec<CatalogApproxDecision>, CatalogError> {
    let mut stmt =
        conn.prepare("SELECT a,b,relation,explicit FROM catalog_approx ORDER BY ord DESC,a,b")?;
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, bool>(3)?,
        ))
    })?
    .map(|row| {
        let (a, b, relation, explicit) = row?;
        Ok(CatalogApproxDecision {
            a,
            b,
            relation: relation.map(|s| serde_json::from_str(&s)).transpose()?,
            explicit,
        })
    })
    .collect()
}
fn migrations(conn: &Connection) -> Result<Vec<CatalogApproxMigration>, CatalogError> {
    let mut stmt=conn.prepare("SELECT source,a,b,confirmed FROM catalog_approx_migration ORDER BY library_id,local_a,local_b")?;
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, bool>(3)?,
        ))
    })?
    .map(|row| {
        let (source, a, b, confirmed) = row?;
        Ok(CatalogApproxMigration {
            source: serde_json::from_str(&source)?,
            a,
            b,
            confirmed,
        })
    })
    .collect()
}
struct Pending {
    a: String,
    b: String,
    current: Option<ApproxRelation>,
    sources: Vec<CatalogApproxMigration>,
}
fn pending(conn: &Connection) -> Result<Vec<Pending>, CatalogError> {
    let choices = decisions(conn)?
        .into_iter()
        .map(|d| ((d.a.clone(), d.b.clone()), d))
        .collect::<BTreeMap<_, _>>();
    let mut sources = BTreeMap::<(String, String), Vec<CatalogApproxMigration>>::new();
    for migration in migrations(conn)? {
        sources
            .entry((migration.a.clone(), migration.b.clone()))
            .or_default()
            .push(migration);
    }
    let mut out = Vec::new();
    for ((a, b), sources) in sources {
        let fresh = sources.iter().filter(|s| !s.confirmed).collect::<Vec<_>>();
        if fresh.is_empty() {
            continue;
        }
        let choice = choices.get(&(a.clone(), b.clone())).filter(|d| d.explicit);
        let conflict = if let Some(choice) = choice {
            fresh
                .iter()
                .any(|s| Some(s.source.rule.relation) != choice.relation)
        } else {
            fresh
                .iter()
                .any(|s| s.source.rule.relation == ApproxRelation::Similar)
                && fresh
                    .iter()
                    .any(|s| s.source.rule.relation == ApproxRelation::NotSimilar)
        };
        if conflict {
            out.push(Pending {
                a,
                b,
                current: choice.and_then(|d| d.relation),
                sources,
            });
        }
    }
    Ok(out)
}
fn origins(sources: impl IntoIterator<Item = CatalogApproxMigration>) -> Vec<CatalogApproxOrigin> {
    sources
        .into_iter()
        .map(|m| CatalogApproxOrigin {
            library_id: m.source.library_id,
            library_name: m.source.library_name,
            library_root: m.source.library_root,
            relation: m.source.rule.relation,
        })
        .collect()
}
fn save_choice(
    tx: &Transaction<'_>,
    a: &str,
    b: &str,
    relation: Option<ApproxRelation>,
) -> Result<(), CatalogError> {
    tx.execute("INSERT INTO catalog_approx(a,b,relation,explicit,ord) VALUES (?1,?2,?3,1,(SELECT coalesce(max(ord),-1)+1 FROM catalog_approx)) ON CONFLICT(a,b) DO UPDATE SET relation=excluded.relation,explicit=1,ord=excluded.ord",params![a,b,relation.map(|r|serde_json::to_string(&r)).transpose()?])?;
    tx.execute(
        "UPDATE catalog_approx_migration SET confirmed=1 WHERE a=?1 AND b=?2",
        params![a, b],
    )?;
    Ok(())
}
impl TagCatalog {
    /// Complete stable-identity rules for Search and settings backup. UI adapters authorize labels separately.
    pub fn approx_definitions(&self) -> Result<Vec<PersonalApprox>, CatalogError> {
        Ok(decisions(&self.conn)?
            .into_iter()
            .filter_map(|d| {
                d.relation.map(|relation| PersonalApprox {
                    a: d.a,
                    b: d.b,
                    relation,
                })
            })
            .collect())
    }
    /// Includes explicit deletion/ignore memory for settings replacement and restart.
    pub fn approx_decisions(&self) -> Result<Vec<CatalogApproxDecision>, CatalogError> {
        decisions(&self.conn)
    }
    pub fn approx_migrations(&self) -> Result<Vec<CatalogApproxMigration>, CatalogError> {
        migrations(&self.conn)
    }
    /// Unresolved opposite legacy rules hold expansion; an explicit global judgment stays authoritative.
    pub fn approx_search_rules(&self) -> Result<Vec<PersonalApprox>, CatalogError> {
        let mut rules = self.approx_definitions()?;
        for conflict in pending(&self.conn)? {
            if conflict.current.is_some() {
                continue;
            }
            rules.retain(|r| {
                (r.a.as_str(), r.b.as_str()) != (conflict.a.as_str(), conflict.b.as_str())
            });
            rules.push(PersonalApprox {
                a: conflict.a,
                b: conflict.b,
                relation: ApproxRelation::NotSimilar,
            });
        }
        Ok(rules)
    }
    pub fn approx_view(
        &self,
        vocabulary: &Vocabulary,
        lang: &str,
    ) -> Result<CatalogApproxView, CatalogError> {
        let visible = vocabulary
            .tags
            .iter()
            .map(|t| (t.id.as_str(), t))
            .collect::<BTreeMap<_, _>>();
        let label = |id: &str| {
            visible.get(id).map(|t| {
                crate::library::display_label(id, t.namespace, &t.names, &t.external, lang)
            })
        };
        let mut by_pair = BTreeMap::<(String, String), Vec<CatalogApproxMigration>>::new();
        for migration in self.approx_migrations()? {
            by_pair
                .entry((migration.a.clone(), migration.b.clone()))
                .or_default()
                .push(migration);
        }
        let entries = self
            .approx_definitions()?
            .into_iter()
            .filter_map(|rule| {
                Some(CatalogApproxEntry {
                    a: label(&rule.a)?,
                    b: label(&rule.b)?,
                    relation: rule.relation,
                    sources: origins(by_pair.remove(&(rule.a, rule.b)).unwrap_or_default()),
                })
            })
            .collect();
        let conflicts = pending(&self.conn)?
            .into_iter()
            .filter_map(|p| {
                Some(CatalogApproxConflict {
                    a: label(&p.a)?,
                    b: label(&p.b)?,
                    current: p.current,
                    sources: origins(p.sources),
                })
            })
            .collect();
        Ok(CatalogApproxView {
            revision: self.revision()?,
            entries,
            conflicts,
        })
    }
    /// Save one action atomically against the caller-authorized vocabulary.
    pub fn edit_approx(
        &mut self,
        edit: &CatalogApproxEdit,
        vocabulary: &Vocabulary,
    ) -> Result<(), CatalogError> {
        let visible = vocabulary
            .tags
            .iter()
            .map(|t| t.id.as_str())
            .collect::<BTreeSet<_>>();
        let pair = |a: &str, b: &str| -> Result<(String, String), CatalogError> {
            if a == b {
                return Err(crate::library::Error::SameTag.into());
            }
            if !visible.contains(a) || !visible.contains(b) {
                return Err(CatalogError::UnknownTag);
            }
            Ok(ordered(a.into(), b.into()))
        };
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        match edit {
            CatalogApproxEdit::Set { rules } => {
                for rule in rules {
                    let (a, b) = pair(&rule.a, &rule.b)?;
                    save_choice(&tx, &a, &b, Some(rule.relation))?;
                }
            }
            CatalogApproxEdit::Remove { a, b } => {
                let (a, b) = pair(a, b)?;
                save_choice(&tx, &a, &b, None)?;
            }
            CatalogApproxEdit::ResolveConflict {
                a,
                b,
                revision,
                relation,
            } => {
                let (a, b) = pair(a, b)?;
                let current: i64 =
                    tx.query_row("SELECT value FROM catalog_revision", [], |r| r.get(0))?;
                if current != *revision {
                    return Err(CatalogError::StaleApproxConflict);
                }
                let conflict = pending(&tx)?
                    .into_iter()
                    .find(|p| p.a == a && p.b == b)
                    .ok_or(CatalogError::StaleApproxConflict)?;
                save_choice(&tx, &a, &b, relation.or(conflict.current))?;
            }
        }
        tx.execute("UPDATE catalog_revision SET value=value+1", [])?;
        tx.commit()?;
        Ok(())
    }
}
