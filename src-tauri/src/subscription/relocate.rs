//! 改了收进的图库以后，把订阅留在旧库的图移过去（#461）。规则在
//! `kinshoko_core::subscription::relocate`。
//!
//! 锁的次序是先图库、后参考组（永久删除的预览就是这样拿的），所以这里不能拿着参考组的锁再开图库：
//! 先在参考组的锁里一次读好哪些旧图用在参考组里，放开锁，再去开图库移图。

use std::collections::{BTreeMap, HashSet};

use kinshoko_core::command_error::CommandError;
use kinshoko_core::library::{self, Library, SaveDestination};
use kinshoko_core::reference_groups::{GroupError, GroupUsage, ReferenceGroupUsage};
use kinshoko_core::subscription::relocate::{self, MoveReport, OldImages};
use kinshoko_core::subscription::{MovedWork, Store};
use tauri::AppHandle;

use super::{publish, require};

struct Opened(AppHandle);

impl relocate::Libraries for Opened {
    fn with(
        &self,
        library_id: &str,
        f: &mut dyn FnMut(&Library) -> Result<(), library::Error>,
    ) -> Result<(), CommandError> {
        let destination = SaveDestination {
            library_id: library_id.to_owned(),
            folder_id: None,
        };
        crate::library::with_destination(&self.0, &destination, |library| Ok(f(library)?))
    }
}

/// 参考组用到的旧图（资料库，参考图），在参考组的锁里读好。
struct UsedInGroups(HashSet<(String, String)>);

impl ReferenceGroupUsage for UsedInGroups {
    fn groups_using(
        &self,
        library_id: &str,
        image_ids: &[String],
    ) -> Result<Vec<GroupUsage>, GroupError> {
        let used: Vec<String> = image_ids
            .iter()
            .filter(|id| self.0.contains(&(library_id.to_owned(), (*id).clone())))
            .cloned()
            .collect();
        Ok(if used.is_empty() {
            Vec::new()
        } else {
            vec![GroupUsage {
                group_id: String::new(),
                name: String::new(),
                image_ids: used,
            }]
        })
    }
}

fn used_in_groups(
    app: &AppHandle,
    store: &Store,
    ids: &[String],
) -> Result<UsedInGroups, CommandError> {
    let mut by_library: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for page in store.old_pages(ids)? {
        by_library
            .entry(page.library_id)
            .or_default()
            .push(page.image_id);
    }
    crate::desktop::with_groups(app, |groups| {
        let mut used = HashSet::new();
        for (library_id, image_ids) in &by_library {
            for usage in groups.groups_using(library_id, image_ids)? {
                for image_id in usage.image_ids {
                    used.insert((library_id.clone(), image_id));
                }
            }
        }
        Ok(UsedInGroups(used))
    })
    .unwrap_or_else(|| Err(crate::library::groups_not_ready()))
}

/// 这几条订阅留在旧库的图：每条订阅每个旧库能移几张、留下几张。
#[tauri::command]
pub async fn subscription_old_images(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<OldImages>, CommandError> {
    let store = require(&app)?.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let used = used_in_groups(&app, &store, &ids)?;
        relocate::old_images(&store, &Opened(app.clone()), &used, &ids)
    })
    .await
    .map_err(CommandError::system)?
}

/// 把这几条订阅留在旧库、没整理过的图移到它们现在收进的图库。
#[tauri::command]
pub async fn subscription_move_old(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<MoveReport, CommandError> {
    let store = require(&app)?.store.clone();
    let worker = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let used = used_in_groups(&worker, &store, &ids)?;
        relocate::move_old(&store, &Opened(worker.clone()), &used, &ids)
    })
    .await
    .map_err(CommandError::system)??;
    publish(&app);
    Ok(report)
}

/// 撤销 [`subscription_move_old`]。
#[tauri::command]
pub async fn subscription_undo_move(
    app: AppHandle,
    works: Vec<MovedWork>,
) -> Result<(), CommandError> {
    let store = require(&app)?.store.clone();
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        relocate::undo_move(&store, &Opened(worker), &works)
    })
    .await
    .map_err(CommandError::system)??;
    publish(&app);
    Ok(())
}
