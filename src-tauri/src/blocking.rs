use kinshoko_core::CommandError;

/// Run blocking command work off the async executor and report worker failures as command errors.
pub(crate) async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(CommandError::system)?
}
