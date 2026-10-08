import { useEffect, useRef, useState } from "react";
import { closeImportPreview, onSafeModeSetting, onWorkspaceChanged, openImportPreview, readImportPreview } from "../ipc";

/** Modal/focus lifecycle adapted from approved prototype/reference-browser/components/Overlays.tsx. */
export function SealedImportPreview({ libraryId, taskId, onClose }: { libraryId: string; taskId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [images, setImages] = useState<{ id: string; url: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, sessionId: string | null = null;
    const urls = new Set<string>();
    const end = () => { alive = false; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); void closeImportPreview(sessionId).catch(() => {}); close.current(); };
    const modal = dialog.current!;
    modal.showModal();
    const cancel = (event: Event) => { event.preventDefault(); end(); };
    const hidden = () => { if (document.hidden) end(); };
    modal.addEventListener("cancel", cancel);
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
      modal.removeEventListener("cancel", cancel); document.removeEventListener("visibilitychange", hidden); modal.close();
    };
  }, [libraryId, taskId]);
  return <dialog ref={dialog} className="sealed-import-preview" aria-label="本次封印重复项预览">
    <header><h2>本次封印重复项</h2><button type="button" aria-label="关闭重复项预览" onClick={onClose}>×</button></header>
    <p>只读预览。安全模式保持开启，关闭后重新遮蔽。</p>
    {problem ? <p role="alert">预览已停止：{problem}</p> : images.length === 0 && <p role="status">正在读取本次重复项…</p>}
    <div className="sealed-import-preview-images">{images.map(image => <img key={image.id} src={image.url} alt="本次导入的重复项" />)}</div>
  </dialog>;
}
