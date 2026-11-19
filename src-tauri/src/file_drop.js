(() => {
  if (location.origin !== "__KINSHOKO_APP_ORIGIN__") return;
  const invokeKey = "__KINSHOKO_INVOKE_KEY__";
  window.__KINSHOKO_FILE_DROP__ = (files) => {
    const ipc = window.__TAURI_INTERNALS__;
    const callback = ipc.transformCallback(() => {}, true);
    try {
      window.chrome.webview.postMessageWithAdditionalObjects(
        JSON.stringify({
          cmd: "file_drop_ack",
          callback,
          error: callback,
          payload: { kind: "kinshoko-file-drop", version: 1 },
          __TAURI_INVOKE_KEY__: invokeKey,
        }),
        files,
      );
    } catch (error) {
      ipc.unregisterCallback(callback);
      throw error;
    }
  };
})();
