import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "./invoke";
import { desk } from "./plugins";

export type FileDrop =
  | { kind: "enter"; paths: string[] }
  | { kind: "drop"; paths: string[] }
  | { kind: "leave" }
  | { kind: "error"; error: unknown };

type FileBridge = {
  __KINSHOKO_FILE_DROP__: (files: FileList) => void;
};

/** 文件或文件夹拖进主窗口：进入、松开（带路径）、离开。 */
export async function onFileDrop(handler: (drop: FileDrop) => void): Promise<UnlistenFn> {
  const stop = await getCurrentWebview().listen<string[]>("kinshoko-file-drop", ({ payload }) => {
    handler({ kind: "drop", paths: payload });
  });
  let depth = 0;
  let active = true;
  const stage = async (dropped: File[]) => {
    try {
      const paths: string[] = [];
      for (const file of dropped) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        paths.push(
          await invoke<string>(desk("stage_dropped_image"), bytes, {
            headers: { "x-file-name": encodeURIComponent(file.name) },
          }),
        );
      }
      if (active) handler({ kind: "drop", paths });
    } catch (error) {
      if (active) handler({ kind: "error", error });
    }
  };
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
      try {
        (window as unknown as FileBridge).__KINSHOKO_FILE_DROP__(dropped);
      } catch {
        void stage(Array.from(dropped));
      }
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
    active = false;
    window.removeEventListener("dragenter", enter, true);
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("dragleave", leave, true);
    window.removeEventListener("drop", drop, true);
    window.removeEventListener("dragend", clear, true);
    window.removeEventListener("keydown", key, true);
    stop();
  };
}
