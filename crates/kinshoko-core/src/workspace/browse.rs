//! 工作区的图片墙浏览与单张卡片。
use super::*;

/// 一组浏览结果里的一张卡片。占位图不属于结果，按页现取，所以这里的 `card` 不带它
/// （`placeholder` 为 `None`）。
struct BrowseRow {
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
    /// 浏览一页：[`Self::browse_rows`]、读占位图、[`Self::confirm`] 连着做。应用壳在锁外读占位图，
    /// 分开调用这三步。
    pub fn browse(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        query: &WorkspaceQuery,
        safe: bool,
    ) -> Result<WorkspacePage, CatalogError> {
        let mut pending = self.browse_rows(device, catalog, query, safe)?;
        pending.fill_placeholders(&self.gate);
        self.confirm(device, catalog, pending)
    }
    /// 浏览一页的行，还不带占位图（#313）：只切出当页的卡片，占位图由调用方在锁外读
    /// （[`PendingPage::fill_placeholders`]），读完交给 [`Self::confirm`] 复核。
    pub fn browse_rows(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        query: &WorkspaceQuery,
        safe: bool,
    ) -> Result<PendingPage, CatalogError> {
        // 分段耗时（#288、#313）：记进运行日志，与应用壳的总耗时对照。
        let started = std::time::Instant::now();
        let snapshot = self.snapshot(device, catalog)?;
        crate::diagnostics::took("浏览：取快照", started, None);
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
        let collecting = std::time::Instant::now();
        let rows = match cached {
            Some(rows) => rows,
            None => {
                self.browse_cache.builds += 1;
                let rows = collect_rows(&snapshot, query, safe, |r| self.provider(device, r))?;
                crate::diagnostics::took("浏览：排出结果", collecting, Some(rows.len()));
                std::sync::Arc::new(rows)
            }
        };
        let total = rows.len() as u32;
        let limit = query.limit.clamp(1, 1000) as usize;
        let next = offset.saturating_add(limit);
        let next_cursor = (next < rows.len()).then(|| format!("{key}:{next}"));
        let cards = rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|row| row.card.clone())
            .collect::<Vec<_>>();
        let sources = snapshot
            .providers
            .iter()
            .filter(|p| {
                cards
                    .iter()
                    .any(|c| c.library_id == p.registration.library.id)
            })
            .map(|p| p.registration.library.clone())
            .collect();
        Ok(PendingPage {
            page: WorkspacePage {
                cards,
                total,
                next_cursor,
                status,
            },
            revision: snapshot.status.revision.clone(),
            sources,
            known: query.known_placeholders.iter().cloned().collect(),
            built: (reuse && !hit).then_some((key, rows)),
        })
    }
    /// 读完占位图再复核一次，复用结果时也一样：这期间某张图被封印，就不能带着旧的 `adult` 和
    /// 占位图交出去。Includes registration, catalog and changes in providers that did not match
    /// this query.
    pub fn confirm(
        &mut self,
        device: &DeviceLibraries,
        catalog: &mut TagCatalog,
        pending: PendingPage,
    ) -> Result<WorkspacePage, CatalogError> {
        if self.snapshot(device, catalog)?.status.revision != pending.revision {
            return Err(Error::CursorExpired.into());
        }
        if let Some((key, rows)) = pending.built {
            self.browse_cache.put(key, rows);
        }
        Ok(pending.page)
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
            placeholder: self
                .provider(device, &provider.registration.library)?
                .placeholders(&[&hash])?
                .remove(&hash),
            adult,
            library_id: library_id.into(),
            image_id: image_id.into(),
            sources,
            id: hash,
        })
    }
}

/// 浏览的一页，还不带占位图（#313），见 [`Workspace::browse_rows`]。
pub struct PendingPage {
    page: WorkspacePage,
    /// 取这一页时的快照修订号，[`Workspace::confirm`] 按它复核。
    revision: String,
    /// 当页卡片显示用的来源。
    sources: Vec<crate::RegisteredLibrary>,
    /// 调用方已经有占位图的卡片，不再读。
    known: BTreeSet<String>,
    /// 新算出的一组结果，复核通过后才留着复用。
    built: Option<(String, std::sync::Arc<Vec<BrowseRow>>)>,
}

impl PendingPage {
    /// 只为这一页读占位图：按显示用的来源分组，每个资料库一条查询，用 `gate` 长期握着的只读句柄，
    /// 不拿全局锁；调用方已有的不读。卡片 id 就是原图字节的 SHA-256。句柄不在手里或读不出时这些卡片不带占位图
    /// （界面退回中性底色），不影响这一页。
    pub fn fill_placeholders(&mut self, gate: &ImageGate) {
        let cards = &mut self.page.cards;
        let mut found = std::collections::HashMap::new();
        for source in &self.sources {
            let Some(library) = gate.held(source) else {
                continue;
            };
            let shas = cards
                .iter()
                .filter(|c| c.library_id == source.id && !self.known.contains(&c.id))
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>();
            if let Ok(placeholders) = library.placeholders(&shas) {
                found.extend(placeholders);
            }
        }
        for card in cards.iter_mut() {
            card.placeholder = found.remove(&card.id);
        }
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
                card: WorkspaceCard {
                    id,
                    width: image.width,
                    height: image.height,
                    adult,
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
