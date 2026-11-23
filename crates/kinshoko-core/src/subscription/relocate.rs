//! 改了收进的资料库以后，把订阅留在旧库的图移到现在的库（#461）。
//!
//! 以作品为单位：一个作品的各页都能移才移（见 [`Library::movable_image`]），新库已记着同一个作品
//! 时不移。几个作品共用同一张图时，其中一个留下，共用的那些都留下。图先收进新库，再改订阅记录，
//! 最后把旧库的那张移进回收站。撤销按 [`MovedWork`] 反过来做。

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::CommandError;
use crate::library::{self, FactSource, Library, MovableImage, ReceivedMove, ReceivedPageRef};
use crate::reference_groups::ReferenceGroupUsage;

use super::store::{MovedPage, MovedWork, OldPage, Store};

/// 按资料库 id 找到打开着的资料库。没打开或打不开时报原因。
pub trait Libraries {
    fn with(
        &self,
        library_id: &str,
        f: &mut dyn FnMut(&Library) -> Result<(), library::Error>,
    ) -> Result<(), CommandError>;
}

/// 一条订阅留在一个旧库的图：能移的、留下的各几张（按页计）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OldImages {
    pub subscription_id: String,
    pub library_id: String,
    pub movable: u32,
    pub kept: u32,
}

/// 移了多少，以及撤销用的记录。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MoveReport {
    /// 移过去的图（按页计）。
    pub moved: u32,
    /// 留在旧库的图（按页计）。
    pub kept: u32,
    pub works: Vec<MovedWork>,
}

type WorkKey = (String, String, String, String); // 订阅、库、来源、作品

struct Plan {
    pages: Vec<OldPage>,
    images: HashMap<(String, String), MovableImage>,
    movable: HashSet<WorkKey>,
}

fn key(p: &OldPage) -> WorkKey {
    (
        p.subscription_id.clone(),
        p.library_id.clone(),
        p.source.clone(),
        p.work_id.clone(),
    )
}

fn plan(
    store: &Store,
    libraries: &dyn Libraries,
    usage: &dyn ReferenceGroupUsage,
    ids: &[String],
) -> Result<Plan, CommandError> {
    let pages = store.old_pages(ids)?;
    // 每个旧库的每张图被哪些页指着。
    let mut by_image: BTreeMap<(String, String), Vec<ReceivedPageRef>> = BTreeMap::new();
    for p in &pages {
        let refs = by_image
            .entry((p.library_id.clone(), p.image_id.clone()))
            .or_default();
        let r = ReceivedPageRef {
            source: p.source.clone(),
            work_id: p.work_id.clone(),
            page: p.page,
        };
        if !refs.contains(&r) {
            refs.push(r);
        }
    }
    let mut images = HashMap::new();
    for ((library_id, image_id), refs) in &by_image {
        let mut found = None;
        // 旧库没打开：这些图留在原处，下次再看。
        let _ = libraries.with(library_id, &mut |library| {
            found = library.movable_image(image_id, refs, usage)?;
            Ok(())
        });
        if let Some(found) = found {
            images.insert((library_id.clone(), image_id.clone()), found);
        }
    }
    let mut movable: HashSet<WorkKey> = pages.iter().map(key).collect();
    loop {
        let stuck: HashSet<(String, String)> = pages
            .iter()
            .filter(|p| {
                p.blocked
                    || !movable.contains(&key(p))
                    || !images.contains_key(&(p.library_id.clone(), p.image_id.clone()))
            })
            .map(|p| (p.library_id.clone(), p.image_id.clone()))
            .collect();
        let before = movable.len();
        for p in &pages {
            if p.blocked || stuck.contains(&(p.library_id.clone(), p.image_id.clone())) {
                movable.remove(&key(p));
            }
        }
        if movable.len() == before {
            break;
        }
    }
    Ok(Plan {
        pages,
        images,
        movable,
    })
}

/// 这几条订阅留在旧库的图，每条订阅每个旧库一项。
pub fn old_images(
    store: &Store,
    libraries: &dyn Libraries,
    usage: &dyn ReferenceGroupUsage,
    ids: &[String],
) -> Result<Vec<OldImages>, CommandError> {
    let plan = plan(store, libraries, usage, ids)?;
    let mut out: Vec<OldImages> = Vec::new();
    for p in &plan.pages {
        let i = match out
            .iter()
            .position(|o| o.subscription_id == p.subscription_id && o.library_id == p.library_id)
        {
            Some(i) => i,
            None => {
                out.push(OldImages {
                    subscription_id: p.subscription_id.clone(),
                    library_id: p.library_id.clone(),
                    movable: 0,
                    kept: 0,
                });
                out.len() - 1
            }
        };
        if plan.movable.contains(&key(p)) {
            out[i].movable += 1;
        } else {
            out[i].kept += 1;
        }
    }
    Ok(out)
}

/// 把这几条订阅留在旧库、能移的图移到它们现在收进的库。
pub fn move_old(
    store: &Store,
    libraries: &dyn Libraries,
    usage: &dyn ReferenceGroupUsage,
    ids: &[String],
) -> Result<MoveReport, CommandError> {
    let plan = plan(store, libraries, usage, ids)?;
    let mut report = MoveReport::default();
    // 先把要移的图一张张收进新库（同一张图只收一次）。
    let mut placed: HashMap<(String, String), ReceivedMove> = HashMap::new();
    let mut failed: HashSet<(String, String)> = HashSet::new();
    for p in &plan.pages {
        let at = (p.library_id.clone(), p.image_id.clone());
        if !plan.movable.contains(&key(p)) || placed.contains_key(&at) || failed.contains(&at) {
            continue;
        }
        match place(
            libraries,
            &plan.images[&at],
            &p.library_id,
            &p.target_library_id,
        ) {
            Ok(to) => {
                placed.insert(at, to);
            }
            Err(_) => {
                failed.insert(at);
            }
        }
    }
    // 有一张没收成的作品留下；和它共用图的作品也留下（旧库那张图还要用）。
    let mut moving = plan.movable.clone();
    loop {
        let stuck: HashSet<(String, String)> = plan
            .pages
            .iter()
            .filter(|p| {
                let at = (p.library_id.clone(), p.image_id.clone());
                failed.contains(&at) || !moving.contains(&key(p))
            })
            .map(|p| (p.library_id.clone(), p.image_id.clone()))
            .collect();
        let before = moving.len();
        for p in &plan.pages {
            if stuck.contains(&(p.library_id.clone(), p.image_id.clone())) {
                moving.remove(&key(p));
            }
        }
        if moving.len() == before {
            break;
        }
    }
    let mut works: BTreeMap<WorkKey, MovedWork> = BTreeMap::new();
    let mut undo_only: BTreeMap<WorkKey, MovedWork> = BTreeMap::new();
    for p in &plan.pages {
        let at = (p.library_id.clone(), p.image_id.clone());
        let Some(to) = placed.get(&at) else {
            if !moving.contains(&key(p)) {
                report.kept += 1;
            }
            continue;
        };
        let k = key(p);
        let into = if moving.contains(&k) {
            &mut works
        } else {
            report.kept += 1;
            &mut undo_only
        };
        let layer = FactSource::subscription(&p.source, &p.work_id);
        into.entry(k.clone())
            .or_insert_with(|| MovedWork {
                subscription_id: k.0.clone(),
                source: k.2.clone(),
                work_id: k.3.clone(),
                from_library_id: k.1.clone(),
                to_library_id: p.target_library_id.clone(),
                pages: Vec::new(),
            })
            .pages
            .push(MovedPage {
                page: p.page,
                from_image_id: p.image_id.clone(),
                to_image_id: to.image_id.clone(),
                created: to.created,
                restored: to.restored,
                layer_existed: to.had_layers.iter().any(|l| l == layer.as_str()),
            });
    }
    // 留下的作品：撤回已收进新库的。
    for w in undo_only.values() {
        undo_placed(libraries, w);
    }
    let done: Vec<MovedWork> = works.into_values().collect();
    if let Err(e) = store.move_works(&done) {
        for w in &done {
            undo_placed(libraries, w);
        }
        return Err(e.into());
    }
    report.moved = done.iter().map(|w| w.pages.len() as u32).sum();
    // 记录都改好了，再把旧库的图移进回收站。这些图只被移走的作品用着。
    let mut trash: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for w in &done {
        let ids = trash.entry(w.from_library_id.clone()).or_default();
        for p in &w.pages {
            if !ids.contains(&p.from_image_id) {
                ids.push(p.from_image_id.clone());
            }
        }
    }
    for (library_id, ids) in trash {
        // 没能移进回收站：旧库多留一份，不影响新库与记录。
        let _ = libraries.with(&library_id, &mut |library| library.trash_moved(&ids));
    }
    report.works = done;
    Ok(report)
}

fn place(
    libraries: &dyn Libraries,
    image: &MovableImage,
    from: &str,
    to: &str,
) -> Result<ReceivedMove, CommandError> {
    let mut bytes = None;
    libraries.with(from, &mut |library| {
        let path = library.moved_original(&image.image_id)?;
        bytes = Some(std::fs::read(path).map_err(library::Error::Io)?);
        Ok(())
    })?;
    let mut out = None;
    if let Some(bytes) = bytes {
        libraries.with(to, &mut |library| {
            out = Some(library.receive_moved(image, &bytes)?);
            Ok(())
        })?;
    }
    out.ok_or_else(|| library::Error::UnknownImage.into())
}

/// 撤回这个作品在新库加上的来源层；新库原来的样子（已有的来源、在回收站里）照旧。
fn undo_placed(libraries: &dyn Libraries, work: &MovedWork) {
    let layer = FactSource::subscription(&work.source, &work.work_id);
    let mut seen = HashSet::new();
    for p in &work.pages {
        if !seen.insert(p.to_image_id.clone()) {
            continue;
        }
        let layers = if p.layer_existed {
            Vec::new()
        } else {
            vec![layer.clone()]
        };
        // 没能撤回：新库多留一份合并来源的图，不影响记录。
        let _ = libraries.with(&work.to_library_id, &mut |library| {
            library.undo_receive_moved(&p.to_image_id, &layers, p.created, p.restored)
        });
    }
}

/// 撤销 [`move_old`]：旧库的图恢复，订阅记录改回旧库，新库去掉这次加的来源。
pub fn undo_move(
    store: &Store,
    libraries: &dyn Libraries,
    works: &[MovedWork],
) -> Result<(), CommandError> {
    let mut restore: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for w in works {
        let ids = restore.entry(w.from_library_id.clone()).or_default();
        for p in &w.pages {
            if !ids.contains(&p.from_image_id) {
                ids.push(p.from_image_id.clone());
            }
        }
    }
    for (library_id, ids) in &restore {
        libraries.with(library_id, &mut |library| library.restore_moved(ids))?;
    }
    let back: Vec<MovedWork> = works.iter().map(MovedWork::reversed).collect();
    store.move_works(&back)?;
    for w in works {
        undo_placed(libraries, w);
    }
    Ok(())
}
