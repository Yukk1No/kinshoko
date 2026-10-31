import { SaveDestinationDialog } from "../library/SaveDestination";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "@base-ui/react/context-menu";
import { BookmarkPlus, Check, Clipboard, Copy, Pin, Scissors, Trash2, X } from "lucide-react";
import { MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import {
  captureHistory,
  captureUrl,
  collectCapture,
  copyCapture,
  deleteCapture,
  onCaptureHistory,
  pinCapture,
  pinClipboard,
  shellSettings,
  startCapture,
} from "../ipc";
import { ago } from "./relativeTime";
import { formatDateTime } from "../i18n/format";

const time = (ms: number) => formatDateTime(ms, { hour: "2-digit", minute: "2-digit" });

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
 * 截图：最近的截图，从新到旧。可以再钉住、复制、选择图库和文件夹收藏、删除。
 * 每一条也有与主窗口同样式的右键菜单（#106）：钉住 · 复制 · 收藏到… · ─ · 删除，与条目上的按钮相同。
 * 没收藏也没钉住的旧截图会被自动丢弃；`libraryId` 是当前资料库，用来显示“已收藏”。
 */
export function CaptureHistoryPanel({ libraryId, request, onRequestHandled }: { libraryId: string | undefined; request?: { id: string; stamp: number } | null; onRequestHandled?: () => void }) {
  const [entries, setEntries] = useState<CaptureEntry[] | null>(null);
  const [collecting, setCollecting] = useState<string | null>(null);
  useEffect(() => { if (request) { setCollecting(request.id); onRequestHandled?.(); } }, [request, onRequestHandled]);
  const [error, setError] = useState<string | null>(null);
  const keys = useShortcutKeys();
  const { t } = useTranslation("desktop", { keyPrefix: "history" });

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
    <section className="capture-history" aria-label={t("label")}>
      <header className="capture-history-bar">
        <h2>{t("title")}</h2>
        <div className="capture-history-start">
          <button type="button" className="k-btn" onClick={() => run(pinClipboard())}>
            <Clipboard size={15} aria-hidden="true" /><span className="k-label">{t("pinClipboard")}</span>{keys.pinClipboard && <kbd className="k-kbd">{keys.pinClipboard}</kbd>}
          </button>
          <button type="button" className="k-btn" onClick={() => void capture()}>
            <Scissors size={15} aria-hidden="true" /><span className="k-label">{t("capture")}</span>
          </button>
        </div>
        <p className="capture-history-note">{keys.capture && t("shortcutNote", { key: keys.capture })}{t("cleanupNote")}</p>
      </header>
      {error && <p className="group-note is-error" role="alert">{error}</p>}
      {entries && entries.length === 0 && <p className="capture-history-empty">{t("empty")}</p>}
      <ul className="capture-history-list">
        {entries?.map((entry) => {
          const collected = entry.collected.some((c) => c.libraryId === libraryId);
          return (
            <ContextMenu.Root key={entry.id}>
              <ContextMenu.Trigger render={<li className="capture-history-item" data-id={entry.id} />}>
                <img src={captureUrl(entry.id)} alt="" loading="lazy" draggable={false} />
                <div className="capture-history-text">
                  <span className="capture-history-name">{t("name", { time: time(entry.createdAt) })}</span>
                  <span className="capture-history-meta k-parts">
                    <span>{entry.width} × {entry.height}</span><span>{ago(entry.createdAt)}</span>{entry.pinned && <span>{t("pinned")}</span>}
                  </span>
                  <span className="capture-history-actions">
                    {collected
                      ? <button type="button" className="side-chip is-done" aria-label={t("collectedAgain")} onClick={() => setCollecting(entry.id)}>
                        <Check size={12} aria-hidden="true" /><span className="k-label">{t("collected")}</span></button>
                      : <button type="button" className="side-chip" onClick={() => setCollecting(entry.id)}><BookmarkPlus size={12} aria-hidden="true" /><span className="k-label">{t("collect")}</span></button>}
                    <button type="button" className="side-chip" onClick={() => run(pinCapture(entry.id))}><Pin size={12} aria-hidden="true" /><span className="k-label">{t("pin")}</span></button>
                    <button type="button" className="side-chip" onClick={() => run(copyCapture(entry.id))}><Copy size={12} aria-hidden="true" /><span className="k-label">{t("copy")}</span></button>
                  </span>
                </div>
                <button type="button" className="k-icon-btn capture-history-delete" aria-label={t("deleteLabel")} title={t("delete")} onClick={() => run(deleteCapture(entry.id))}>
                  <X size={14} aria-hidden="true" />
                </button>
              </ContextMenu.Trigger>
              <MenuPopup label={t("menuLabel")}>
                <MenuItem icon={<Pin size={14} />} onClick={() => run(pinCapture(entry.id))}>{t("pin")}</MenuItem>
                <MenuItem icon={<Copy size={14} />} onClick={() => run(copyCapture(entry.id))}>{t("copy")}</MenuItem>
                <MenuItem icon={<BookmarkPlus size={14} />} onClick={() => setCollecting(entry.id)}>{t("collectTo")}</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={14} />} danger onClick={() => run(deleteCapture(entry.id))}>{t("delete")}</MenuItem>
              </MenuPopup>
            </ContextMenu.Root>
          );
        })}
      </ul>
      {collecting && (
        <SaveDestinationDialog
          title={t("collectTitle")}
          description={t("collectDescription")}
          summary={<CaptureSummary entry={entries?.find((entry) => entry.id === collecting)} id={collecting} />}
          confirmLabel={t("collectConfirm")}
          onClose={() => setCollecting(null)}
          onConfirm={(destination) => collectCapture(collecting, destination)}
        />
      )}
    </section>
  );
}

/** 收藏对话框里要收藏的那张截图：缩略图、名称与尺寸。 */
function CaptureSummary({ entry, id }: { entry: CaptureEntry | undefined; id: string }) {
  const { t } = useTranslation("desktop", { keyPrefix: "history" });
  return (
    <>
      <img className="capture-collect-thumb" src={captureUrl(id)} alt="" draggable={false} />
      <span className="capture-history-text">
        <span className="capture-history-name">{entry ? t("name", { time: time(entry.createdAt) }) : t("unnamed")}</span>
        {entry && <span className="capture-history-meta">{entry.width} × {entry.height}</span>}
      </span>
    </>
  );
}
