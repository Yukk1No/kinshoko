//! 改了收进的资料库以后，把订阅留在旧库的图移到现在的库（#461）。
//!
//! 以作品为单位：一个作品的各页都能移才移（见 [`Library::movable_image`]），新库已记着同一个作品
//! 时不移。几个作品共用同一张图时，其中一个留下，共用的那些都留下。图先收进新库，再改订阅记录，
//! 最后把旧库的那张移进回收站。撤销按 [`MovedWork`] 反过来做。

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::library::{self, FactSource, Library, MovableImage, ReceivedPageRef};
use crate::reference_groups::ReferenceGroupUsage;

use super::store::{MovedPage, MovedWork, OldPage, Store};

/// 按资料库 id 找到打开着的资料库。没打开或打不开时报原因。
pub trait Libraries {
    fn with(
        &self,
        library_id: &str,
        f: &mut dyn FnMut(&Library) -> Result<(), library::Error>,
    ) -> Result<(), String>;
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
) -> Result<Plan, String> {
    let pages = store.old_pages(ids).map_err(|e| e.to_string())?;
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
) -> Result<Vec<OldImages>, String> {
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
) -> Result<MoveReport, String> {
    let plan = plan(store, libraries, usage, ids)?;
    let mut works: BTreeMap<WorkKey, Vec<&OldPage>> = BTreeMap::new();
    let mut report = MoveReport::default();
    for p in &plan.pages {
        if plan.movable.contains(&key(p)) {
            works.entry(key(p)).or_default().push(p);
        } else {
            report.kept += 1;
        }
    }
    // 同一张图只收进新库一次。
    let mut placed: HashMap<(String, String), (String, bool)> = HashMap::new();
    let mut done = Vec::new();
    for (k, pages) in works {
        let target = pages[0].target_library_id.clone();
        let mut moved_pages = Vec::new();
        let mut failed = false;
        for p in &pages {
            let at = (p.library_id.clone(), p.image_id.clone());
            if !placed.contains_key(&at) {
                match place(libraries, &plan.images[&at], &p.library_id, &target) {
                    Ok(to) => {
                        placed.insert(at.clone(), to);
                    }
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            let (to_image_id, created) = placed[&at].clone();
            moved_pages.push(MovedPage {
                page: p.page,
                from_image_id: p.image_id.clone(),
                to_image_id,
                created,
            });
        }
        let work = MovedWork {
            subscription_id: k.0,
            source: k.2,
            work_id: k.3,
            from_library_id: k.1,
            to_library_id: target,
            pages: moved_pages,
        };
        if failed {
            // 这个作品整个留在旧库：已收进新库的页撤回，记录不改。
            report.kept += pages.len() as u32;
            undo_placed(libraries, &work);
            continue;
        }
        match store.move_works(std::slice::from_ref(&work)) {
            Ok(()) => {
                report.moved += work.pages.len() as u32;
                done.push(work);
            }
            Err(_) => {
                report.kept += work.pages.len() as u32;
                undo_placed(libraries, &work);
            }
        }
    }
    // 记录都改好了，再把旧库的图移进回收站。
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
) -> Result<(String, bool), String> {
    let mut bytes = None;
    libraries.with(from, &mut |library| {
        let path = library.moved_original(&image.image_id)?;
        bytes = Some(std::fs::read(path).map_err(library::Error::Io)?);
        Ok(())
    })?;
    let bytes = bytes.ok_or("原图读不到")?;
    let mut out = None;
    libraries.with(to, &mut |library| {
        out = Some(library.receive_moved(image, &bytes)?);
        Ok(())
    })?;
    out.ok_or_else(|| "新库没收进".to_owned())
}

/// 去掉这个作品在新库加上的来源层。
fn undo_placed(libraries: &dyn Libraries, work: &MovedWork) {
    let layer = FactSource::subscription(&work.source, &work.work_id);
    let mut seen = HashSet::new();
    for p in &work.pages {
        if !seen.insert(p.to_image_id.clone()) {
            continue;
        }
        let r = libraries.with(&work.to_library_id, &mut |library| {
            library.undo_receive_moved(&p.to_image_id, std::slice::from_ref(&layer), p.created)
        });
        // 没能撤回：新库多留一份合并来源的图，不影响记录。
        let _ = r;
    }
}

/// 撤销 [`move_old`]：旧库的图恢复，订阅记录改回旧库，新库去掉这次加的来源。
pub fn undo_move(
    store: &Store,
    libraries: &dyn Libraries,
    works: &[MovedWork],
) -> Result<(), String> {
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
    store.move_works(&back).map_err(|e| e.to_string())?;
    for w in works {
        undo_placed(libraries, w);
    }
    Ok(())
}
