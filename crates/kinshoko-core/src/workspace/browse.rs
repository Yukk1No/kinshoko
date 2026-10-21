//! 工作区的图片墙浏览与单张卡片（从 workspace.rs 原样搬出）。
use super::*;

impl Workspace {
    pub fn browse(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        query: &WorkspaceQuery,
        safe: bool,
    ) -> Result<WorkspacePage, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let status = snapshot.status(safe);
        if let WorkspaceScope::Library { library_id, .. } = &query.scope {
            let provider = snapshot
                .providers
                .iter()
                .find(|p| p.registration.library.id == *library_id)
                .ok_or_else(|| {
                    CatalogError::Io(std::io::Error::other(
                        "本设备没有登记这个资料库；当前查找范围保持原值",
                    ))
                })?;
            if let Some(reason) = &provider.registration.unavailable {
                return Err(CatalogError::Io(std::io::Error::other(reason.clone())));
            }
        }
        let key = digest(&serde_json::to_vec(&(
            &status.revision,
            &query.scope,
            &query.conditions,
        ))?);
        let offset = match &query.cursor {
            None => 0,
            Some(cursor) => {
                let (revision, offset) = cursor.split_once(':').ok_or(Error::InvalidCursor)?;
                if revision != key {
                    return Err(Error::CursorExpired.into());
                }
                offset.parse::<usize>().map_err(|_| Error::InvalidCursor)?
            }
        };
        let mut matches = BTreeMap::<String, BTreeSet<String>>::new();
        for provider in &snapshot.providers {
            if provider.registration.unavailable.is_some() {
                continue;
            }
            let id = &provider.registration.library.id;
            let scope = match &query.scope {
                WorkspaceScope::Library { library_id, scope } if library_id == id => scope.clone(),
                WorkspaceScope::Library { .. } => continue,
                WorkspaceScope::All => BrowseScope::All,
            };
            let tree = local_tree(&query.conditions, &snapshot.catalog, id);
            let library = device
                .read(id)
                .map_err(|e| CatalogError::Io(std::io::Error::other(e.to_string())))?;
            let found = library.provider_matches(&scope, &tree)?;
            if library.provider_revision()? != (provider.list, provider.revision) {
                return Err(Error::CursorExpired.into());
            }
            matches.insert(id.clone(), found);
        }
        let matched = |provider: &Provider, image: &ProviderImage| {
            matches
                .get(&provider.registration.library.id)
                .is_some_and(|ids| ids.contains(&image.id))
        };
        let mut groups = BTreeMap::<String, Vec<(&Provider, &ProviderImage)>>::new();
        for provider in &snapshot.providers {
            for image in &provider.images {
                groups
                    .entry(image.sha256.clone())
                    .or_default()
                    .push((provider, image));
            }
        }
        let mut rows = Vec::new();
        for (id, sources) in groups {
            let adult = snapshot.adult.contains(&id);
            if safe && adult {
                continue;
            }
            let Some((provider, image)) = sources.iter().find(|(p, i)| matched(p, i)) else {
                continue;
            };
            let source_library = &provider.registration.library.id;
            let newest = sources
                .iter()
                .filter(|(p, i)| matched(p, i))
                .map(|(_, i)| i.seq)
                .max()
                .unwrap_or(0);
            rows.push((
                newest,
                &provider.registration.library.root,
                WorkspaceCard {
                    id,
                    width: image.width,
                    height: image.height,
                    adult,
                    thumbnail: crate::library::provider::thumbnail_address(
                        source_library,
                        &image.id,
                        query.thumbnail_px,
                    ),
                    placeholder: None,
                    library_id: source_library.clone(),
                    image_id: image.id.clone(),
                    sources: sources
                        .iter()
                        .map(|(p, i)| WorkspaceSource {
                            library_id: p.registration.library.id.clone(),
                            library_name: p.registration.library.name.clone(),
                            image_id: i.id.clone(),
                            deleted: i.deleted,
                            unavailable: p.registration.unavailable.clone(),
                            matches: matched(p, i),
                        })
                        .collect(),
                },
            ));
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.id.cmp(&b.2.id)));
        let total = rows.len() as u32;
        let limit = query.limit.clamp(1, 1000) as usize;
        let next = offset.saturating_add(limit);
        let next_cursor = (next < rows.len()).then(|| format!("{key}:{next}"));
        // Includes registration, catalog and changes in providers that did not match this query.
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        Ok(WorkspacePage {
            cards: rows
                .into_iter()
                .skip(offset)
                .take(limit)
                // 只为这一页读占位图文件；卡片 id 就是原图字节的 SHA-256。
                .map(|(_, root, card)| WorkspaceCard {
                    placeholder: crate::library::placeholder(root, &card.id),
                    ..card
                })
                .collect(),
            total,
            next_cursor,
            status,
        })
    }
    /// 一张图的卡片，与图片墙（[`Self::browse`]）同样构成：id 是字节身份，带全部来源，显示所请求的
    /// 那份来源。给不经图片墙打开的入口用（钉图“在 Kinshoko 中打开”），查看器里的整理据此核对来源。
    /// 没有查找条件，“符合当前查找”只标所请求的来源。
    pub fn card(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        library_id: &str,
        image_id: &str,
        safe: bool,
        thumbnail_px: u32,
    ) -> Result<WorkspaceCard, CatalogError> {
        let snapshot = self.snapshot(device, catalog)?;
        let hash = snapshot
            .identities
            .get(&(library_id.into(), image_id.into()))
            .ok_or(Error::UnknownImage)?
            .clone();
        let adult = snapshot.adult.contains(&hash);
        if safe && adult {
            return Err(Error::UnknownImage.into());
        }
        let mut shown = None;
        let mut sources = Vec::new();
        for provider in &snapshot.providers {
            for image in provider.images.iter().filter(|i| i.sha256 == hash) {
                let requested =
                    provider.registration.library.id == library_id && image.id == image_id;
                if requested {
                    shown = Some((provider, image));
                }
                sources.push(WorkspaceSource {
                    library_id: provider.registration.library.id.clone(),
                    library_name: provider.registration.library.name.clone(),
                    image_id: image.id.clone(),
                    deleted: image.deleted,
                    unavailable: provider.registration.unavailable.clone(),
                    matches: requested,
                });
            }
        }
        let (provider, image) = shown.ok_or(Error::UnknownImage)?;
        Ok(WorkspaceCard {
            width: image.width,
            height: image.height,
            thumbnail: crate::library::provider::thumbnail_address(
                library_id,
                image_id,
                thumbnail_px,
            ),
            placeholder: crate::library::placeholder(&provider.registration.library.root, &hash),
            adult,
            library_id: library_id.into(),
            image_id: image_id.into(),
            sources,
            id: hash,
        })
    }
}
