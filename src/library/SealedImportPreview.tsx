import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { closeImportPreview, onSafeModeSetting, onWorkspaceChanged, openImportPreview, readImportPreview } from "../ipc";

/**
 * 本次封印重复项的预览（#78 故事 42、43）：只展开这一次导入的重复项，全局安全模式保持开启；
 * 关闭、切换安全模式、工作区变化或窗口隐藏时立即结束并重新遮蔽。界面系统的模态对话框（Base UI）。
 */
export function SealedImportPreview({ libraryId, taskId, onClose }: { libraryId: string; taskId: string; onClose: () => void }) {
  const { t } = useTranslation("importing", { keyPrefix: "sealedPreview" });
  const close = useRef(onClose); close.current = onClose;
  const [images, setImages] = useState<{ id: string; url: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, sessionId: string | null = null;
    const urls = new Set<string>();
    const end = () => { alive = false; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); void closeImportPreview(sessionId).catch(() => {}); close.current(); };
    const hidden = () => { if (document.hidden) end(); };
    document.addEventListener("visibilitychange", hidden);
    const safe = onSafeModeSetting(end);
    const workspace = onWorkspaceChanged(end);
    void openImportPreview(libraryId, taskId).then(async session => {
      sessionId = session.id;
      if (!alive) { await closeImportPreview(session.id); return; }
      for (const id of session.items) {
        const bytes = await readImportPreview(session.id, id);
        if (!alive) return;
        const url = URL.createObjectURL(new Blob([bytes])); urls.add(url);
        setImages(previous => [...previous, { id, url }]);
      }
    }).catch(error => { if (alive) { setProblem(String(error)); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); setImages([]); void closeImportPreview(sessionId).catch(() => {}); } });
    return () => {
      alive = false; for (const url of urls) URL.revokeObjectURL(url); urls.clear();
      void closeImportPreview(sessionId).catch(() => {});
      void safe.then(stop => stop()); void workspace.then(stop => stop());
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [libraryId, taskId]);
  // Esc 与关闭按钮经 onOpenChange 关闭；与原来的原生模态框一样，点遮罩不关闭（只在明确关闭或上下文变化时结束）。
  // 卸载时上面的清理结束预览会话并撤销图片。
  return <Dialog.Root open disablePointerDismissal onOpenChange={(open) => { if (!open) close.current(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog sealed-import-preview">
        <Dialog.Close className="k-icon-btn k-dialog-x" aria-label={t("close")}><X size={16} aria-hidden="true" /></Dialog.Close>
        <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">{t("description")}</Dialog.Description>
        {problem ? <p className="k-set-error" role="alert">{t("stopped", { problem })}</p> : images.length === 0 && <p className="k-set-note" role="status">{t("loading")}</p>}
        <div className="sealed-import-preview-images">{images.map(image => <img key={image.id} src={image.url} alt={t("alt")} />)}</div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
