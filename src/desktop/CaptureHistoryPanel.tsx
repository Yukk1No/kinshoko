import { SaveDestinationDialog } from "../library/SaveDestination";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { BookmarkPlus, Check, Clipboard, Pin, Scissors, X } from "lucide-react";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import {
  captureHistory,
  captureUrl,
  collectCapture,
  deleteCapture,
  onCaptureHistory,
  pinCapture,
  pinClipboard,
  shellSettings,
  startCapture,
} from "../ipc";
import { ago } from "./relativeTime";

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 实际生效的全局快捷键（被清除或没注册上的不显示）。 */
function useShortcutKeys() {
  const [keys, setKeys] = useState<Partial<Record<ShortcutAction, string>>>({});
  useEffect(() => {
    let alive = true;
    shellSettings().then((view) => {
      if (!alive || !view) return;
      setKeys(Object.fromEntries(view.shortcuts.filter((s) => s.accelerator && !s.problem).map((s) => [s.action, s.accelerator!])));
    }, () => {});
    return () => { alive = false; };
  }, []);
  return keys;
}

/**
 * 截图：最近的截图，从新到旧。可以再钉住、选择图库和文件夹收藏、删除。
 * 没收藏也没钉住的旧截图会被自动丢弃；`libraryId` 是当前资料库，用来显示“已收藏”。
 */
export function CaptureHistoryPanel({ libraryId, request, onRequestHandled }: { libraryId: string | undefined; request?: { id: string; stamp: number } | null; onRequestHandled?: () => void }) {
  const [entries, setEntries] = useState<CaptureEntry[] | null>(null);
  const [collecting, setCollecting] = useState<string | null>(null);
  useEffect(() => { if (request) { setCollecting(request.id); onRequestHandled?.(); } }, [request, onRequestHandled]);
  const [error, setError] = useState<string | null>(null);
  const keys = useShortcutKeys();

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
        <h2>截图</h2>
        <div className="capture-history-start">
          <button type="button" className="k-btn" onClick={() => run(pinClipboard())}>
            <Clipboard size={15} aria-hidden="true" />钉住剪贴板{keys.pinClipboard && <kbd className="k-kbd">{keys.pinClipboard}</kbd>}
          </button>
          <button type="button" className="k-btn" title="先收起主窗口，再框选屏幕" onClick={() => void capture()}>
            <Scissors size={15} aria-hidden="true" />截图
          </button>
        </div>
        <p className="capture-history-note">{keys.capture && `按 ${keys.capture} 截取屏幕。`}没收藏的旧截图会自动清理。</p>
      </header>
      {error && <p className="group-note is-error" role="alert">{error}</p>}
      {entries && entries.length === 0 && <p className="capture-history-empty">还没有截图。</p>}
      <ul className="capture-history-list">
        {entries?.map((entry) => {
          const collected = entry.collected.some((c) => c.libraryId === libraryId);
          return (
            <li key={entry.id} className="capture-history-item" data-id={entry.id}>
              <img src={captureUrl(entry.id)} alt="" loading="lazy" draggable={false} />
              <div className="capture-history-text">
                <span className="capture-history-name">截图 {time(entry.createdAt)}</span>
                <span className="capture-history-meta">
                  {entry.width} × {entry.height} · {ago(entry.createdAt)}{entry.pinned && " · 已钉住"}
                </span>
                <span className="capture-history-actions">
                  {collected
                    ? <button type="button" className="side-chip is-done" aria-label="已收藏，再收藏到别处" title="再收藏到别的图库或文件夹" onClick={() => setCollecting(entry.id)}>
                      <Check size={12} aria-hidden="true" />已收藏</button>
                    : <button type="button" className="side-chip" onClick={() => setCollecting(entry.id)}><BookmarkPlus size={12} aria-hidden="true" />收藏</button>}
                  <button type="button" className="side-chip" onClick={() => run(pinCapture(entry.id))}><Pin size={12} aria-hidden="true" />钉住</button>
                </span>
              </div>
              <button type="button" className="k-icon-btn capture-history-delete" aria-label="删除这张截图" title="删除" onClick={() => run(deleteCapture(entry.id))}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {collecting && <SaveDestinationDialog title="收藏截图" onClose={() => setCollecting(null)} onConfirm={(destination) => collectCapture(collecting, destination)} />}
    </section>
  );
}
