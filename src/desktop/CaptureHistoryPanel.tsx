import { SaveDestinationDialog } from "../library/SaveDestination";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/Toast";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Tooltip } from "@base-ui/react/tooltip";
import { BookmarkCheck, BookmarkPlus, Copy, Pin, Trash2, X } from "lucide-react";
import { MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import {
  captureHistory,
  captureUrl,
  collectCapture,
  copyCapture,
  deleteCapture,
  onCaptureHistory,
  pinCapture,
} from "../ipc";
import { ago } from "./relativeTime";
import { formatMoment } from "../i18n/format";

/** 当天只显示时间，其他天带日期，免得跨天的两条同是“09:05”分不清。 */
const time = (ms: number) => formatMoment(ms, { todayAsTime: true });

/** 只有图标的操作按钮；悬停或键盘聚焦时用提示写出它做什么。 */
function ItemAction({ label, className, onClick, children }: { label: string; className: string; onClick: () => void; children: ReactNode }) {
  return <Tooltip.Root>
    <Tooltip.Trigger render={<button type="button" className={className} aria-label={label} onClick={onClick} />}>
      {children}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Positioner className="k-positioner" side="top" sideOffset={6}>
        <Tooltip.Popup className="k-tip">{label}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}

/**
 * 截图：最近的截图，从新到旧。可以再钉住、复制、选择图库和文件夹收藏、删除。
 * 每一条也有与主窗口同样式的右键菜单（#106）：钉住 · 复制 · 收藏到… · ─ · 删除，与条目上的按钮相同。
 * 没收藏也没钉住的旧截图会被自动丢弃；收藏进任何一个图库都显示“已收藏”。
 */
export function CaptureHistoryPanel({ request, onRequestHandled }: { request?: { id: string; stamp: number } | null; onRequestHandled?: () => void }) {
  const [entries, setEntries] = useState<CaptureEntry[] | null>(null);
  const [collecting, setCollecting] = useState<string | null>(null);
  useEffect(() => { if (request) { setCollecting(request.id); onRequestHandled?.(); } }, [request, onRequestHandled]);
  const toast = useToast();
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
    action.catch((e) => toast.error(String(e)));
  };

  return (
    <section className="capture-history" aria-label={t("label")}>
      {entries && entries.length === 0 && <p className="capture-history-empty">{t("empty")}</p>}
      <Tooltip.Provider delay={400}>
        <ul className="capture-history-list">
          {entries?.map((entry) => {
            const collected = entry.collected.length > 0;
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
                      <ItemAction label={collected ? t("collectedAgain") : t("collectHint")} className={`k-icon-btn is-sm${collected ? " is-done" : ""}`} onClick={() => setCollecting(entry.id)}>
                        {collected ? <BookmarkCheck size={14} aria-hidden="true" /> : <BookmarkPlus size={14} aria-hidden="true" />}
                      </ItemAction>
                      <ItemAction label={t("pinHint")} className="k-icon-btn is-sm" onClick={() => run(pinCapture(entry.id))}><Pin size={14} aria-hidden="true" /></ItemAction>
                      <ItemAction label={t("copyHint")} className="k-icon-btn is-sm" onClick={() => run(copyCapture(entry.id))}><Copy size={14} aria-hidden="true" /></ItemAction>
                    </span>
                  </div>
                  <ItemAction label={t("deleteLabel")} className="k-icon-btn capture-history-delete" onClick={() => run(deleteCapture(entry.id))}>
                    <X size={14} aria-hidden="true" />
                  </ItemAction>
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
      </Tooltip.Provider>
      {collecting && (
        <SaveDestinationDialog
          title={t("collectTitle")}
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
