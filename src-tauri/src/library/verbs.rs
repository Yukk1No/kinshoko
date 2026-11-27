//! Command pipelines for organizing, reading and querying a library or workspace.

use std::future::Future;
use std::panic::Location;
use std::sync::Arc;

use kinshoko_core::safe_mode::LensStale;
use kinshoko_core::tag_catalog::{CatalogError, TagCatalog};
use kinshoko_core::workspace::Workspace;
use kinshoko_core::{CommandError, DeviceLibraries, DeviceLibraryError, Library, VisibilityPermit};
use tauri::{AppHandle, Manager, Runtime};

use super::LibraryState;
use super::access::{readable, writable};
use super::lens::{Hold, with_lens_at};
use crate::blocking::blocking;

/// Wait for the named library's organize writer, then run a mutation on it.
pub(super) async fn organize<R: Runtime, T: Send + 'static, E: Into<CommandError>>(
    app: AppHandle<R>,
    library_id: String,
    action: impl FnOnce(&Library) -> Result<T, E> + Send + 'static,
) -> Result<T, CommandError> {
    blocking(move || {
        let library = writable(&app, &library_id)?;
        action(&library).map_err(Into::into)
    })
    .await
}

/// Read from the named library using its visibility settings.
pub(super) async fn browse<R: Runtime, T: Send + 'static, E: Into<CommandError>>(
    app: AppHandle<R>,
    library_id: String,
    action: impl FnOnce(&Arc<Library>) -> Result<T, E> + Send + 'static,
) -> Result<T, CommandError> {
    blocking(move || {
        let library = readable(&app, &library_id)?;
        action(&library).map_err(Into::into)
    })
    .await
}

/// Query the workspace with the visibility and revision guarantees specified by `hold`.
#[track_caller]
pub(super) fn lens<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    safe_mode: bool,
    hold: Hold,
    action: impl FnOnce(
        &mut Workspace,
        &mut DeviceLibraries,
        &mut TagCatalog,
    ) -> Result<T, CatalogError>
    + Send
    + 'static,
) -> impl Future<Output = Result<T, CommandError>> {
    let site = Location::caller();
    blocking(move || with_lens_at(&app, safe_mode, hold, site, action))
}

/// Query using the saved safe mode and map a stale lens to the command's error.
#[allow(dead_code, reason = "Call sites migrate after #776")]
#[track_caller]
pub(super) fn current_lens<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    stale: impl FnOnce(LensStale) -> CommandError + Send + 'static,
    action: impl FnOnce(
        &mut Workspace,
        &mut DeviceLibraries,
        &mut TagCatalog,
        bool,
    ) -> Result<T, CatalogError>
    + Send
    + 'static,
) -> impl Future<Output = Result<T, CommandError>> {
    let site = Location::caller();
    blocking(move || {
        app.state::<LibraryState>()
            .session
            .with_current_lens_at(site, stale, action)
    })
}

/// Commit a registry change and finish forwarding or cleanup under the transition lock.
#[allow(dead_code, reason = "Call sites migrate after #776")]
#[track_caller]
pub(super) fn transition_commit<R: Runtime, P, T: Send + 'static>(
    app: AppHandle<R>,
    commit: impl FnOnce(&mut DeviceLibraries) -> Result<P, DeviceLibraryError> + Send + 'static,
    after_commit: impl FnOnce(&AppHandle<R>, P) -> Result<T, CommandError> + Send + 'static,
) -> impl Future<Output = Result<T, CommandError>> {
    let site = Location::caller();
    blocking(move || {
        app.state::<LibraryState>()
            .session
            .with_transition_commit_at(site, commit, |committed| after_commit(&app, committed))
    })
}

/// Act on one visible image: `prepare` (decode, crop…) runs outside the visibility permit; `apply`
/// (the clipboard write, the send) runs inside it only after the session re-confirmed safe mode
/// and that the image is still visible ([`VisibilityPermit::commit_image`]).
pub(crate) async fn commit_image<R: Runtime, P, T: Send + 'static>(
    app: AppHandle<R>,
    library_id: String,
    image_id: String,
    prepare: impl FnOnce(&Arc<Library>, &str) -> Result<P, CommandError> + Send + 'static,
    apply: impl FnOnce(&AppHandle<R>, P) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    blocking(move || {
        VisibilityPermit::commit_image(
            &app.state::<LibraryState>().session,
            &library_id,
            &image_id,
            |library| prepare(library, &image_id),
            |_, prepared| apply(&app, prepared),
        )
    })
    .await
}
