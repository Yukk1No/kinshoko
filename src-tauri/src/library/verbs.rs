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
use super::lens::Hold;
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
    blocking(move || {
        app.state::<LibraryState>()
            .session
            .with_lens_at(safe_mode, hold, site, action)
    })
}

/// Query using the saved safe mode and map a stale lens to the command's error.
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    fn collect_rs_files(dir: &Path, files: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read src directory") {
            let path = entry.expect("read src directory entry").path();
            if path.is_dir() {
                collect_rs_files(&path, files);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                files.push(path);
            }
        }
    }

    fn blank(masked: &mut [u8], start: usize, end: usize) {
        for byte in &mut masked[start..end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    }

    fn mask_non_code(source: &str) -> String {
        let bytes = source.as_bytes();
        let mut masked = bytes.to_vec();
        let mut cursor = 0;
        while cursor < bytes.len() {
            if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'/') {
                let start = cursor;
                cursor += 2;
                while cursor < bytes.len() && bytes[cursor] != b'\n' {
                    cursor += 1;
                }
                blank(&mut masked, start, cursor);
            } else if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'*') {
                let start = cursor;
                cursor += 2;
                let mut depth = 1;
                while cursor < bytes.len() && depth > 0 {
                    if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'*') {
                        depth += 1;
                        cursor += 2;
                    } else if bytes[cursor] == b'*' && bytes.get(cursor + 1) == Some(&b'/') {
                        depth -= 1;
                        cursor += 2;
                    } else {
                        cursor += 1;
                    }
                }
                blank(&mut masked, start, cursor);
            } else if bytes[cursor] == b'"' {
                let start = cursor;
                cursor += 1;
                while cursor < bytes.len() {
                    if bytes[cursor] == b'\\' {
                        cursor = (cursor + 2).min(bytes.len());
                    } else if bytes[cursor] == b'"' {
                        cursor += 1;
                        break;
                    } else {
                        cursor += 1;
                    }
                }
                blank(&mut masked, start, cursor);
            } else if bytes[cursor] == b'r' {
                let mut quote = cursor + 1;
                while bytes.get(quote) == Some(&b'#') {
                    quote += 1;
                }
                if bytes.get(quote) == Some(&b'"') {
                    let start = cursor;
                    let hashes = quote - cursor - 1;
                    let mut scan = quote + 1;
                    while scan < bytes.len() {
                        if bytes[scan] == b'"' {
                            let end = scan + 1 + hashes;
                            if end <= bytes.len()
                                && bytes[scan + 1..end].iter().all(|byte| *byte == b'#')
                            {
                                scan = end;
                                break;
                            }
                        }
                        scan += 1;
                    }
                    cursor = scan.min(bytes.len());
                    blank(&mut masked, start, cursor);
                } else {
                    cursor += 1;
                }
            } else {
                cursor += 1;
            }
        }
        String::from_utf8(masked).expect("masked Rust source remains valid UTF-8")
    }

    fn sources() -> Vec<(String, String)> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let src = manifest.join("src");
        let mut files = Vec::new();
        collect_rs_files(&src, &mut files);
        files.sort();
        assert!(!files.is_empty());
        files
            .into_iter()
            .map(|path| {
                let relative = path
                    .strip_prefix(&manifest)
                    .expect("source under manifest directory")
                    .to_string_lossy()
                    .replace('\\', "/");
                let source = fs::read_to_string(path).expect("read Rust source");
                (relative, mask_non_code(&source))
            })
            .collect()
    }

    fn identifier_byte(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || byte == b'_'
    }

    fn free_identifier_call(source: &str, identifier: &str) -> bool {
        let bytes = source.as_bytes();
        let mut offset = 0;
        while let Some(relative) = source[offset..].find(identifier) {
            let at = offset + relative;
            let end = at + identifier.len();
            offset = end;
            let before = at.checked_sub(1).map(|index| bytes[index]);
            let after = bytes.get(end).copied();
            if before.is_some_and(identifier_byte) || after.is_some_and(identifier_byte) {
                continue;
            }
            if matches!(before, Some(b'.') | Some(b':')) {
                continue;
            }
            let mut tail = end;
            while tail < bytes.len() && bytes[tail].is_ascii_whitespace() {
                tail += 1;
            }
            if bytes.get(tail) == Some(&b'(') {
                return true;
            }
        }
        false
    }

    fn functions(source: &str) -> Vec<(String, String)> {
        let bytes = source.as_bytes();
        let mut functions = Vec::new();
        let mut offset = 0;
        while let Some(relative) = source[offset..].find("fn ") {
            let keyword = offset + relative;
            if keyword > 0 && identifier_byte(bytes[keyword - 1]) {
                offset = keyword + 3;
                continue;
            }
            let mut cursor = keyword + 3;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            let name_start = cursor;
            while cursor < bytes.len() && identifier_byte(bytes[cursor]) {
                cursor += 1;
            }
            if cursor == name_start {
                offset = keyword + 3;
                continue;
            }
            let name = source[name_start..cursor].to_owned();
            let mut scan = cursor;
            let mut open = None;
            while scan < bytes.len() {
                if bytes[scan] == b'{' {
                    open = Some(scan);
                    break;
                }
                if bytes[scan] == b';' {
                    break;
                }
                scan += 1;
            }
            let Some(open) = open else {
                offset = cursor;
                continue;
            };
            let mut depth = 0usize;
            let mut end = None;
            scan = open;
            while scan < bytes.len() {
                if bytes[scan] == b'{' {
                    depth += 1;
                } else if bytes[scan] == b'}' {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end = Some(scan + 1);
                        break;
                    }
                }
                scan += 1;
            }
            let Some(end) = end else {
                break;
            };
            functions.push((name, source[open..end].to_owned()));
            offset = end;
        }
        functions
    }

    #[test]
    fn retired_session_wrappers_stay_out() {
        let retired = [
            concat!("with_visibility", "_commit"),
            concat!("capture", "_generation"),
            concat!("workspace::with", "_resources"),
        ];
        let offenders = sources()
            .into_iter()
            .flat_map(|(path, source)| {
                retired
                    .iter()
                    .filter(|token| source.contains(*token))
                    .map(|token| format!("{path}: {token}"))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert!(
            offenders.is_empty(),
            "retired session wrappers must not reappear: {offenders:?}"
        );
    }

    #[test]
    fn catalog_lock_is_taken_through_the_session() {
        let catalog = concat!("with", "_catalog");
        let offenders = sources()
            .into_iter()
            .filter(|(_, source)| free_identifier_call(source, catalog))
            .map(|(path, _)| path)
            .collect::<Vec<_>>();
        assert!(
            offenders.is_empty(),
            "catalog locking must go through session methods, not a free wrapper: {offenders:?}"
        );
    }

    #[test]
    fn transition_visibility_nesting_stays_in_session() {
        let transition = concat!(".transition", "()");
        let visibility = concat!(".with", "_visibility(");
        let allowed = [
            ("src/library/organize_commands.rs", "write_visible"),
            (
                "src/library/settings_backup.rs",
                "restore_application_settings",
            ),
        ];
        let mut offenders = Vec::new();
        let mut allowlist_seen = Vec::new();
        for (path, source) in sources() {
            for (name, body) in functions(&source) {
                if !body.contains(transition) || !body.contains(visibility) {
                    continue;
                }
                let site = format!("{path}::{name}");
                if allowed.contains(&(path.as_str(), name.as_str())) {
                    allowlist_seen.push(site);
                } else {
                    offenders.push(site);
                }
            }
        }
        assert_eq!(
            allowlist_seen.len(),
            allowed.len(),
            "the guard must still see both allowlisted nestings: {allowlist_seen:?}"
        );
        assert!(
            offenders.is_empty(),
            "hand-written transition/visibility nesting outside the allowlist: {offenders:?}"
        );
    }
}
