//! 工作区快照：各提供方的清单、标签计数与安全索引，提供方与标签目录的修订号不变时复用（从 workspace.rs 原样搬出）。
use super::*;

impl Workspace {
    /// Only provider/catalog revisions and availability are read on a cache hit.
    /// Inventory, tag counts and source safety indexes rebuild only after those facts change.
    /// 提供方经长期打开的只读句柄读（[`ImageGate`]，#313），修订号每次都读，复用的句柄不掩盖变化。
    /// 取到的快照发布给缩略图请求的放行。
    pub(super) fn snapshot(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
    ) -> Result<std::sync::Arc<Snapshot>, CatalogError> {
        let registry = device.registry_generation();
        let snapshot = self.build_snapshot(device, catalog)?;
        self.gate.publish(snapshot.clone(), registry);
        Ok(snapshot)
    }
    fn build_snapshot(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
    ) -> Result<std::sync::Arc<Snapshot>, CatalogError> {
        let mut readers = BTreeMap::new();
        let mut observed = Vec::new();
        let scope = device.safe_mode_scope();
        for registration in device.libraries() {
            let result = self.gate.reader(registration, scope).and_then(|library| {
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
                // Detached reader only, always unfiltered (see `ImageGate`).
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
