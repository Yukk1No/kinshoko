//! 工作区的图片墙浏览与单张卡片。
use super::*;

/// 一组浏览结果里的一张卡片。缩略图地址与占位图不属于结果，按页现取，所以这里的 `card`
/// 不带它们（`thumbnail` 为空、`placeholder` 为 `None`），不能直接交出去。
struct BrowseRow {
    root: std::path::PathBuf,
    card: WorkspaceCard,
}

/// 最近几组排好的浏览结果，键与游标里的相同（#288）：同一组结果翻页、从头重读只切片。
/// 键里含修订号、范围与条件，修订号一变旧结果就再也取不到，不需要另外失效。留几组而不是一组，
/// 免得两处用不同条件交替浏览时互相挤掉。按分级查找的结果不留（[`reads_ratings`]）。
#[derive(Default)]
pub(super) struct BrowseCache {
    results: std::collections::VecDeque<(String, std::sync::Arc<Vec<BrowseRow>>)>,
    builds: usize,
}
impl BrowseCache {
    const KEEP: usize = 4;
    fn get(&mut self, key: &str) -> Option<std::sync::Arc<Vec<BrowseRow>>> {
        let at = self.results.iter().position(|(k, _)| k == key)?;
        let hit = self.results.remove(at)?;
        self.results.push_front(hit);
        self.results.front().map(|(_, rows)| rows.clone())
    }
    fn put(&mut self, key: String, rows: std::sync::Arc<Vec<BrowseRow>>) {
        self.results.push_front((key, rows));
        self.results.truncate(Self::KEEP);
    }
}

impl Workspace {
    /// 浏览结果重算了几次（#288）：同一组结果的翻页与重读不该增加它。只供测试观察。
    #[doc(hidden)]
    pub fn browse_builds(&self) -> usize {
        self.browse_cache.builds
    }
    pub fn browse(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        query: &WorkspaceQuery,
        safe: bool,
    ) -> Result<WorkspacePage, CatalogError> {
        // 分段耗时（#288）：开发构建在控制台输出，与 Tauri 层的总耗时一行对照。
        #[cfg(debug_assertions)]
        let started = std::time::Instant::now();
        let snapshot = self.snapshot(device, catalog)?;
        #[cfg(debug_assertions)]
        let snapshot_ms = started.elapsed().as_secs_f64() * 1e3;
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
        // 按分级查找的结果不复用：来源分级没跨过安全模式范围时不推进修订号。
        let reuse = !reads_ratings(&query.conditions);
        let cached = reuse.then(|| self.browse_cache.get(&key)).flatten();
        let hit = cached.is_some();
        let rows = match cached {
            Some(rows) => rows,
            None => {
                self.browse_cache.builds += 1;
                std::sync::Arc::new(collect_rows(&snapshot, query, safe, |r| {
                    self.provider(device, r)
                })?)
            }
        };
        #[cfg(debug_assertions)]
        let rows_ms = started.elapsed().as_secs_f64() * 1e3 - snapshot_ms;
        let total = rows.len() as u32;
        let limit = query.limit.clamp(1, 1000) as usize;
        let next = offset.saturating_add(limit);
        let next_cursor = (next < rows.len()).then(|| format!("{key}:{next}"));
        let cards = rows
            .iter()
            .skip(offset)
            .take(limit)
            // 只为这一页读占位图文件；卡片 id 就是原图字节的 SHA-256。
            .map(|row| WorkspaceCard {
                thumbnail: crate::library::provider::thumbnail_address(
                    &row.card.library_id,
                    &row.card.image_id,
                    query.thumbnail_px,
                ),
                placeholder: crate::library::placeholder(&row.root, &row.card.id),
                ..row.card.clone()
            })
            .collect::<Vec<_>>();
        // 做完整页（含读占位图）再复核一次，复用结果时也一样：这期间某张图被封印，就不能带着
        // 旧的 `adult` 和占位图交出去。Includes registration, catalog and changes in providers
        // that did not match this query.
        if self.snapshot(device, catalog)?.status.revision != snapshot.status.revision {
            return Err(Error::CursorExpired.into());
        }
        if reuse && !hit {
            self.browse_cache.put(key.clone(), rows);
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "workspace.browse.phases snapshot={snapshot_ms:.1} rows={rows_ms:.1}({}) page={:.1} cards={}",
            if hit { "hit" } else { "build" },
            started.elapsed().as_secs_f64() * 1e3 - snapshot_ms - rows_ms,
            cards.len()
        );
        #[cfg(not(debug_assertions))]
        let _ = hit;
        Ok(WorkspacePage {
            cards,
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

/// 条件里有没有按有效分级匹配的项（点选的分级，或文字也匹配某档分级的名称）。
fn reads_ratings(tree: &ConditionTree) -> bool {
    tree.conditions
        .iter()
        .flat_map(|c| &c.any)
        .any(|term| match term {
            Term::Rating { .. } => true,
            Term::Text { ratings, .. } => !ratings.is_empty(),
            Term::Tag { .. } => false,
        })
}

/// 一组浏览结果：每个来源各自跑完整的查找，再按字节身份合并，按最新加入排序。
fn collect_rows(
    snapshot: &Snapshot,
    query: &WorkspaceQuery,
    safe: bool,
    reader: impl Fn(
        &crate::RegisteredLibrary,
    ) -> Result<std::sync::Arc<crate::library::Library>, CatalogError>,
) -> Result<Vec<BrowseRow>, CatalogError> {
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
        let library = reader(&provider.registration.library)?;
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
            BrowseRow {
                root: provider.registration.library.root.clone(),
                card: WorkspaceCard {
                    id,
                    width: image.width,
                    height: image.height,
                    adult,
                    // 按页现取（[`Workspace::browse`]）：缩略图尺寸不属于这组结果。
                    thumbnail: String::new(),
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
            },
        ));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.card.id.cmp(&b.1.card.id)));
    Ok(rows.into_iter().map(|(_, row)| row).collect())
}
