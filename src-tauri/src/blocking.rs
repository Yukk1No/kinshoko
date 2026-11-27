use kinshoko_core::CommandError;

/// Run blocking command work off the async executor and report worker failures as command errors.
pub(crate) async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(CommandError::system)?
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

    #[test]
    fn spawn_blocking_stays_out_of_commands() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let src = manifest.join("src");
        let mut files = Vec::new();
        collect_rs_files(&src, &mut files);
        files.sort();
        assert!(!files.is_empty());

        let allowed = [
            "src/blocking.rs",
            "src/lib.rs",
            "src/library.rs",
            "src/library/access.rs",
            "src/desktop/mod.rs",
        ];
        let offenders = files
            .into_iter()
            .filter(|path| {
                fs::read_to_string(path)
                    .expect("read Rust source")
                    .contains("spawn_blocking")
            })
            .map(|path| {
                path.strip_prefix(&manifest)
                    .expect("source under manifest directory")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .filter(|path| !allowed.contains(&path.as_str()))
            .collect::<Vec<_>>();

        assert!(
            offenders.is_empty(),
            "spawn_blocking may appear only in the non-command allowlist: {allowed:?}; offenders: {offenders:?}"
        );
    }
}
