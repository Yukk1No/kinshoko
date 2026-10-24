//! 工作区快照：各提供方的清单、标签计数与安全索引，提供方与标签目录的修订号不变时复用（从 workspace.rs 原样搬出）。
use super::*;

/// Detached provider readers opened during one request (#123). Scope it to a single request:
/// each registered provider is opened (identity-checked) at most once while it lives. Entries are
/// keyed by registration (id and root), so a provider re-registered elsewhere mid-request is reopened.
#[derive(Default)]
pub struct ProviderReaders(
    BTreeMap<
        String,
        (
            std::path::PathBuf,
            Result<std::sync::Arc<crate::library::Library>, String>,
        ),
    >,
);
impl ProviderReaders {
    /// Open these registrations now, typically before taking the registry/catalog/workspace locks,
    /// so the locked section only reads revisions. Every check still runs under the locks.
    pub fn open_all(&mut self, registrations: &[crate::RegisteredLibrary]) {
        for registration in registrations {
            // 打不开的提供方照常记下原因，锁里的核对按原因报告。
            let _ = self.opened(registration);
        }
    }
    fn opened(
        &mut self,
        registration: &crate::RegisteredLibrary,
    ) -> Result<std::sync::Arc<crate::library::Library>, String> {
        let entry = self.0.get(&registration.id);
        if entry.is_none_or(|(root, _)| *root != registration.root) {
            let library = DeviceLibraries::read_registered(registration).map_err(|e| e.to_string());
            self.0.insert(
                registration.id.clone(),
                (registration.root.clone(), library),
            );
        }
        self.0[&registration.id].1.clone()
    }
    pub(super) fn read(
        &mut self,
        device: &DeviceLibraries,
        library_id: &str,
    ) -> Result<std::sync::Arc<crate::library::Library>, String> {
        let library = match device.libraries().iter().find(|r| r.id == library_id) {
            Some(registration) => self.opened(&registration.clone()),
            None => device.read(library_id).map_err(|e| e.to_string()),
        }?;
        // 只读句柄按本设备的安全模式范围给出浏览视角（#223）。
        library.init_safe_mode_scope(device.safe_mode_scope());
        Ok(library)
    }
}
impl Workspace {
    /// Only provider/catalog revisions and availability are read on a cache hit.
    /// Inventory, tag counts and source safety indexes rebuild only after those facts change.
    pub(super) fn snapshot(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
    ) -> Result<std::sync::Arc<Snapshot>, CatalogError> {
        self.snapshot_reusing(device, catalog, &mut ProviderReaders::default())
    }
    /// Same as [`Self::snapshot`], opening each registered provider at most once per `opened`.
    /// Revisions are still read on every call, so a reused reader never hides a change.
    pub(super) fn snapshot_reusing(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        opened: &mut ProviderReaders,
    ) -> Result<std::sync::Arc<Snapshot>, CatalogError> {
        let mut readers = BTreeMap::new();
        let mut observed = Vec::new();
        for registration in device.libraries() {
            let result = opened.read(device, &registration.id).and_then(|library| {
                let revisions = library.provider_revision().map_err(|e| e.to_string())?;
                Ok((library, revisions))
            });
            match result {
                Ok((library, (list, revision))) => {
                    readers.insert(registration.id.clone(), library);
                    observed.push((registration.clone(), None, list, revision));
                }
                Err(error) => observed.push((registration.clone(), Some(error), -1, -1)),
            }
        }
        observed.sort_by(|a, b| a.0.id.cmp(&b.0.id));
        // 安全模式范围变了，被封印的图跟着变：修订号不同，旧游标与界面的结果都作废（#223）。
        let scope = device.safe_mode_scope();
        let fingerprint = |revision| -> Result<String, CatalogError> {
            Ok(digest(&serde_json::to_vec(&(revision, &observed, scope))?))
        };
        let key = fingerprint(catalog.revision()?)?;
        if let Some(cache) = &self.cache
            && cache.status.revision == key
        {
            return Ok(cache.clone());
        }

        let ids = device
            .libraries()
            .iter()
            .map(|r| r.id.as_str())
            .collect::<BTreeSet<_>>();
        let cached_ids = {
            let mut stmt = self.conn.prepare("SELECT library_id FROM provider_facts")?;
            stmt.query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in cached_ids {
            if !ids.contains(id.as_str()) {
                self.conn
                    .execute("DELETE FROM provider_facts WHERE library_id=?1", [id])?;
            }
        }
        let mut providers = Vec::new();
        for (registration, unavailable, list, revision) in &observed {
            let prior = self.cache.as_ref().and_then(|cache| {
                cache.providers.iter().find(|p| {
                    p.registration.library == *registration
                        && p.registration.unavailable == *unavailable
                        && p.list == *list
                        && p.revision == *revision
                })
            });
            if let Some(prior) = prior {
                providers.push(prior.clone());
                continue;
            }
            let (images, vocabulary) = if let Some(library) = readers.get(&registration.id) {
                // Detached reader only. Current Library's safe mode is never modified.
                library.set_safe_mode(false);
                catalog.synchronize(library)?;
                let snapshot = library.provider_snapshot()?;
                let vocabulary = library.vocabulary()?;
                if (snapshot.list_revision, snapshot.vocabulary_revision) != (*list, *revision)
                    || vocabulary.revision != *revision
                {
                    return Err(Error::CursorExpired.into());
                }
                self.conn.execute("INSERT INTO provider_facts(library_id,images) VALUES (?1,?2) ON CONFLICT(library_id) DO UPDATE SET images=excluded.images",
                    params![registration.id, serde_json::to_string(&snapshot.images)?])?;
                (snapshot.images, Some(vocabulary))
            } else {
                use rusqlite::OptionalExtension;
                let text: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT images FROM provider_facts WHERE library_id=?1",
                        [&registration.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                (
                    text.map(|s| serde_json::from_str(&s))
                        .transpose()?
                        .unwrap_or_default(),
                    None,
                )
            };
            providers.push(Provider {
                registration: LibraryRegistration {
                    library: registration.clone(),
                    unavailable: unavailable.clone(),
                },
                images,
                vocabulary,
                list: *list,
                revision: *revision,
            });
        }
        // Reject an inventory assembled across a provider change.
        for (id, reader) in &readers {
            let (_, _, list, revision) = observed
                .iter()
                .find(|(r, _, _, _)| &r.id == id)
                .expect("registered reader");
            if reader.provider_revision()? != (*list, *revision) {
                return Err(Error::CursorExpired.into());
            }
        }
        let inspection = catalog.inspect()?;
        let key = fingerprint(inspection.revision)?;
        let adult = providers
            .iter()
            .flat_map(|p| &p.images)
            .filter(|i| i.effective_rating().is_some_and(|r| scope.covers(r)))
            .map(|i| i.sha256.clone())
            .collect();
        let identities = providers
            .iter()
            .filter(|p| p.registration.unavailable.is_none())
            .flat_map(|p| {
                p.images.iter().map(|i| {
                    (
                        (p.registration.library.id.clone(), i.id.clone()),
                        i.sha256.clone(),
                    )
                })
            })
            .collect();
        let status = WorkspaceStatus {
            revision: key,
            libraries: providers.iter().map(|p| p.registration.clone()).collect(),
        };
        let snapshot = std::sync::Arc::new(Snapshot {
            personal_approx: catalog.approx_search_rules()?,
            providers,
            catalog: inspection,
            status,
            scope,
            adult,
            identities,
            safe_vocabulary: std::sync::OnceLock::new(),
            full_vocabulary: std::sync::OnceLock::new(),
            safe_management_vocabulary: std::sync::OnceLock::new(),
            full_management_vocabulary: std::sync::OnceLock::new(),
        });
        self.cache = Some(snapshot.clone());
        Ok(snapshot)
    }
}
