import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type FileDrop = { kind: "enter"; paths: string[] } | { kind: "drop"; paths: string[] } | { kind: "leave" };

type FileBridge = {
  __KINSHOKO_FILE_DROP__: (files: FileList) => void;
};

/** 文件或文件夹拖进主窗口：进入、松开（带路径）、离开。 */
export async function onFileDrop(handler: (drop: FileDrop) => void): Promise<UnlistenFn> {
  const stop = await getCurrentWebview().listen<string[]>("kinshoko-file-drop", ({ payload }) => {
    handler({ kind: "drop", paths: payload });
  });
  let depth = 0;
  const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
  const clear = () => {
    if (depth === 0) return;
    depth = 0;
    handler({ kind: "leave" });
  };
  const enter = (event: DragEvent) => {
    if (!files(event)) return;
    event.preventDefault();
    if (depth++ === 0) handler({ kind: "enter", paths: [] });
  };
  const over = (event: DragEvent) => {
    if (files(event)) event.preventDefault();
  };
  const leave = (event: DragEvent) => {
    if (files(event) && depth > 0 && --depth === 0) handler({ kind: "leave" });
  };
  const drop = (event: DragEvent) => {
    clear();
    if (!files(event)) return;
    event.preventDefault();
    const dropped = event.dataTransfer!.files;
    if (dropped.length) {
      (window as unknown as FileBridge).__KINSHOKO_FILE_DROP__(dropped);
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") clear();
  };
  window.addEventListener("dragenter", enter, true);
  window.addEventListener("dragover", over, true);
  window.addEventListener("dragleave", leave, true);
  window.addEventListener("drop", drop, true);
  window.addEventListener("dragend", clear, true);
  window.addEventListener("keydown", key, true);
  return () => {
    window.removeEventListener("dragenter", enter, true);
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("dragleave", leave, true);
    window.removeEventListener("drop", drop, true);
    window.removeEventListener("dragend", clear, true);
    window.removeEventListener("keydown", key, true);
    stop();
  };
}
