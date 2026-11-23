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
    // 几条订阅把同一个作品收进了不同的旧库、现在又收进同一个库：只移第一份，别的留下。
    let mut first: HashMap<(String, String, String), WorkKey> = HashMap::new();
    for p in &pages {
        let at = (
            p.target_library_id.clone(),
            p.source.clone(),
            p.work_id.clone(),
        );
        let k = key(p);
        if first.entry(at).or_insert_with(|| k.clone()) != &k {
            movable.remove(&k);
        }
    }
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

/// 这几条订阅留在旧库的图，每条订阅每个旧库一项。每条订阅单独算，和卡片上一条一条地“移过来”
/// 一致。
pub fn old_images(
    store: &Store,
    libraries: &dyn Libraries,
    usage: &dyn ReferenceGroupUsage,
    ids: &[String],
) -> Result<Vec<OldImages>, CommandError> {
    let mut out: Vec<OldImages> = Vec::new();
    for id in ids {
        let plan = plan(store, libraries, usage, std::slice::from_ref(id))?;
        count_old(&plan, &mut out);
    }
    Ok(out)
}

fn count_old(plan: &Plan, out: &mut Vec<OldImages>) {
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
}

/// 一张旧图收进哪个新库：旧库、旧图、新库。
fn placement(p: &OldPage) -> (String, String, String) {
    (
        p.library_id.clone(),
        p.image_id.clone(),
        p.target_library_id.clone(),
    )
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
    // 先把要移的图一张张收进新库（同一张图收进同一个新库只收一次；几条订阅收进不同的库时各收一份）。
    let mut placed: HashMap<(String, String, String), ReceivedMove> = HashMap::new();
    let mut failed: HashSet<(String, String, String)> = HashSet::new();
    for p in &plan.pages {
        let at = placement(p);
        if !plan.movable.contains(&key(p)) || placed.contains_key(&at) || failed.contains(&at) {
            continue;
        }
        // 只带收进这个新库的作品的页：别的作品收进别的库，来源层不跟过来。
        let mut image = plan.images[&(at.0.clone(), at.1.clone())].clone();
        image.pages.retain(|page| {
            plan.pages
                .iter()
                .any(|o| placement(o) == at && o.source == page.source && o.work_id == page.work_id)
        });
        match place(libraries, &image, &p.library_id, &p.target_library_id) {
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
            .filter(|p| failed.contains(&placement(p)) || !moving.contains(&key(p)))
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
        let Some(to) = placed.get(&placement(p)) else {
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
    // 新库同一张图原来的样子（原来没有、原来在回收站）按全部收进的页汇总，记在每一页上：哪个作品
    // 留下撤回了，移成的作品撤销时照样能回到原来的样子。
    let mut original: HashMap<(String, String), (bool, bool)> = HashMap::new();
    for w in works.values().chain(undo_only.values()) {
        for p in &w.pages {
            let e = original
                .entry((w.to_library_id.clone(), p.to_image_id.clone()))
                .or_default();
            e.0 |= p.created;
            e.1 |= p.restored;
        }
    }
    let done: Vec<MovedWork> = works
        .into_values()
        .map(|mut w| {
            for p in &mut w.pages {
                let (created, restored) =
                    original[&(w.to_library_id.clone(), p.to_image_id.clone())];
                p.created = created;
                p.restored = restored;
            }
            w
        })
        .collect();
    // 新库里还有留下的作品用着的图：撤回时只去掉来源层，不按原来的样子放回回收站。
    let kept: HashSet<(String, String)> = done
        .iter()
        .flat_map(|w| {
            w.pages
                .iter()
                .map(|p| (w.to_library_id.clone(), p.to_image_id.clone()))
        })
        .collect();
    let (undo_only, mut keep) = not_received(store, undo_only.into_values())?;
    keep.extend(kept);
    undo_placed(libraries, undo_only.iter(), &keep);
    if let Err(e) = store.move_works(&done) {
        // 移图期间别的订阅也把同一个作品收进了新库：它的来源层与图都留着。
        let (done, keep) = not_received(store, done.into_iter())?;
        undo_placed(libraries, done.iter(), &keep);
        return Err(e.into());
    }
    report.moved = done.iter().map(|w| w.pages.len() as u32).sum();
    // 记录都改好了，再把旧库的图移进回收站。移图期间这张图又被收进来、被整理过的，留在原处。
    let mut trash: BTreeMap<(String, String), Vec<FactSource>> = BTreeMap::new();
    for w in &done {
        let layer = FactSource::subscription(&w.source, &w.work_id);
        for p in &w.pages {
            let layers = trash
                .entry((w.from_library_id.clone(), p.from_image_id.clone()))
                .or_default();
            if !layers.contains(&layer) {
                layers.push(layer.clone());
            }
        }
    }
    for ((library_id, image_id), layers) in trash {
        if store.image_in_use(&library_id, &image_id)? {
            continue;
        }
        // 没能移进回收站：旧库多留一份，不影响新库与记录。
        let _ = libraries.with(&library_id, &mut |library| {
            library
                .trash_moved_if_untouched(&image_id, &layers)
                .map(drop)
        });
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

/// （资料库，图）。
type ImageAt = (String, String);

/// 撤回前看新库的记录：新库已经记着同一个作品（移图期间别处收进来的）时，这个作品的来源层不撤回；
/// 新库的图有订阅记录指着时，图留着看得见（返回这些图），只去掉没人要的来源层。
fn not_received(
    store: &Store,
    works: impl Iterator<Item = MovedWork>,
) -> Result<(Vec<MovedWork>, HashSet<ImageAt>), CommandError> {
    let mut out = Vec::new();
    let mut in_use = HashSet::new();
    for w in works {
        for p in &w.pages {
            if store.image_in_use(&w.to_library_id, &p.to_image_id)? {
                in_use.insert((w.to_library_id.clone(), p.to_image_id.clone()));
            }
        }
        if !store.work_received(&w.to_library_id, &w.source, &w.work_id)? {
            out.push(w);
        }
    }
    Ok((out, in_use))
}

/// 撤回这些作品在新库加上的来源层；新库原来的样子（已有的来源、在回收站里）照旧。同一张新库的图
/// 汇总起来一次撤回：它原来没有（任一页是这次才有的）时，去掉全部加上的来源后才能判断要不要移进回收站。
fn undo_placed<'a>(
    libraries: &dyn Libraries,
    works: impl Iterator<Item = &'a MovedWork>,
    in_use: &HashSet<(String, String)>,
) {
    // (新库, 新库的图) → (要去掉的来源层, 这次才有, 原来在回收站)
    let mut by_image: BTreeMap<(String, String), (Vec<FactSource>, bool, bool)> = BTreeMap::new();
    for work in works {
        let layer = FactSource::subscription(&work.source, &work.work_id);
        for p in &work.pages {
            let entry = by_image
                .entry((work.to_library_id.clone(), p.to_image_id.clone()))
                .or_default();
            if !p.layer_existed && !entry.0.contains(&layer) {
                entry.0.push(layer.clone());
            }
            entry.1 |= p.created;
            entry.2 |= p.restored;
        }
    }
    for ((library_id, image_id), (layers, created, restored)) in by_image {
        let (created, restored) = if in_use.contains(&(library_id.clone(), image_id.clone())) {
            (false, false)
        } else {
            (created, restored)
        };
        // 没能撤回：新库多留一份合并来源的图，不影响记录。
        let _ = libraries.with(&library_id, &mut |library| {
            library.undo_receive_moved(&image_id, &layers, created, restored)
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
    // 先核对记录：已经不在新库（又移过、又改过）时这条撤销作废，什么都不动。
    let back: Vec<MovedWork> = works.iter().map(MovedWork::reversed).collect();
    store.check_move_works(&back)?;
    // 再恢复旧库的图；旧库打不开时把已恢复的放回回收站，记录不改，之后还能再撤销。
    let mut restored: Vec<(String, Vec<String>)> = Vec::new();
    for (library_id, ids) in &restore {
        let mut out = Vec::new();
        if let Err(e) = libraries.with(library_id, &mut |library| {
            out = library.restore_moved(ids)?;
            Ok(())
        }) {
            put_back(libraries, &restored);
            return Err(e);
        }
        restored.push((library_id.clone(), out));
    }
    if let Err(e) = store.move_works(&back) {
        put_back(libraries, &restored);
        return Err(e.into());
    }
    // 记录改回去以后还有别的页指着的新库图（之后又移来、收来的）：只去掉来源层，不放回回收站。
    let mut in_use = HashSet::new();
    for w in works {
        for p in &w.pages {
            if store.image_in_use(&w.to_library_id, &p.to_image_id)? {
                in_use.insert((w.to_library_id.clone(), p.to_image_id.clone()));
            }
        }
    }
    undo_placed(libraries, works.iter(), &in_use);
    Ok(())
}

/// 撤销没做成：把这次从回收站里拿出来的旧图放回去。
fn put_back(libraries: &dyn Libraries, restored: &[(String, Vec<String>)]) {
    for (library_id, ids) in restored {
        if ids.is_empty() {
            continue;
        }
        // 没能放回：旧库多出一份看得见的图，记录仍指向新库。
        let _ = libraries.with(library_id, &mut |library| library.trash_moved(ids));
    }
}
