import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import {
  captureHistory,
  captureUrl,
  collectCapture,
  deleteCapture,
  onCaptureHistory,
  pinCapture,
  pinClipboard,
  startCapture,
} from "../ipc";

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/**
 * 截图历史：最近的截图，从新到旧。可以再钉住、收藏进当前资料库、删除。
 * 没收藏也没钉住的旧截图会被自动丢弃；`libraryId` 是当前资料库，用来显示“已收藏”。
 */
export function CaptureHistoryPanel({ libraryId }: { libraryId: string | undefined }) {
  const [entries, setEntries] = useState<CaptureEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    captureHistory().then((value) => alive && setEntries(value));
    const unlisten = onCaptureHistory((value) => setEntries(value));
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const run = (action: Promise<unknown>) => {
    setError(null);
    action.catch((e) => setError(String(e)));
  };

  const capture = async () => {
    // 先让开主窗口，免得截到自己。
    await getCurrentWindow().minimize();
    await new Promise((r) => setTimeout(r, 250));
    run(startCapture());
  };

  return (
    <section className="capture-history" aria-label="截图历史">
      <header className="capture-history-bar">
        <h2>截图历史</h2>
        <button type="button" onClick={() => void capture()}>
          截图
        </button>
        <button type="button" onClick={() => run(pinClipboard())}>
          钉剪贴板
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {entries && entries.length === 0 && (
        <p className="capture-history-empty">
          还没有截图。按截图快捷键框选屏幕上任意区域；没收藏也没钉住的旧截图会被自动丢弃。
        </p>
      )}
      <ul className="capture-history-list">
        {entries?.map((entry) => {
          const collected = entry.collected.some((c) => c.libraryId === libraryId);
          return (
            <li key={entry.id} className="capture-history-item" data-id={entry.id}>
              <img src={captureUrl(entry.id)} alt="" loading="lazy" />
              <span className="capture-history-meta">
                {time(entry.createdAt)} · {entry.width}×{entry.height}
                {entry.pinned && " · 已钉住"}
              </span>
              <span className="capture-history-actions">
                <button type="button" onClick={() => run(pinCapture(entry.id))}>
                  钉住
                </button>
                <button
                  type="button"
                  disabled={!libraryId || collected}
                  onClick={() => run(collectCapture(entry.id))}
                >
                  {collected ? "已收藏" : "收藏"}
                </button>
                <button type="button" onClick={() => run(deleteCapture(entry.id))}>
                  删除
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
