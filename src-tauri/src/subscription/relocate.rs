//! 改了收进的图库以后，把订阅留在旧库的图移过去（#461）。规则在
//! `kinshoko_core::subscription::relocate`。移的整个过程在参考组的锁里做：核对“没用在参考组里”
//! 之后、移完之前，参考组不会用上要移的图。

use kinshoko_core::command_error::CommandError;
use kinshoko_core::library::{self, Library, SaveDestination};
use kinshoko_core::subscription::MovedWork;
use kinshoko_core::subscription::relocate::{self, MoveReport, OldImages};
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

/// 这几条订阅留在旧库的图：每条订阅每个旧库能移几张、留下几张。
#[tauri::command]
pub async fn subscription_old_images(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<OldImages>, CommandError> {
    let store = require(&app)?.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::desktop::with_groups(&app, |groups| {
            relocate::old_images(&store, &Opened(app.clone()), groups, &ids)
        })
        .ok_or_else(crate::library::groups_not_ready)?
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
        crate::desktop::with_groups(&worker, |groups| {
            relocate::move_old(&store, &Opened(worker.clone()), groups, &ids)
        })
        .ok_or_else(crate::library::groups_not_ready)?
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
