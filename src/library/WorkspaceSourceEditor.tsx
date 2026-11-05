import { SaveDestinationDialog } from "./SaveDestination";
import { useTranslation } from "react-i18next";
import { errorText, workspaceCopySource } from "../ipc";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import { SelectionPanel } from "./SelectionPanel";
import { Copy } from "lucide-react";

/**
 * 一份来源的详情（#98）：标签、分级、文件夹与备注都只改这一份。钉住和加入参考组在图片墙右键菜单里，
 * 这里只留复制到别的图库。
 */
export function WorkspaceSourceEditor({ card, source, safe, reloadKey, onClose, onChanged }: {
  card: WorkspaceCard; source: WorkspaceSource; safe: boolean; reloadKey: number;
  onClose: () => void; onChanged?: () => void;
}) {
  const { t } = useTranslation("inspector", { keyPrefix: "source" });
  const target: WorkspaceSourceTarget = { libraryId: source.libraryId, imageId: source.imageId, contentId: card.id };
  const key = JSON.stringify([target, safe, reloadKey]);
  const current = useRef(key); current.current = key;
  const [available, setAvailable] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copying,setCopying]=useState(false);
  useEffect(() => { setProblem(null); setNotice(null); }, [key]);
  const onError = useCallback((e: unknown) => setProblem(errorText(e)), []);
  return <div className="workspace-source-editor" aria-label={t("label")} title={source.libraryId + "/" + source.imageId}>
    {problem && <p className="insp-problem" role="alert">{problem}</p>}
    {notice && <p className="insp-notice" role="status">{notice}</p>}
    {!available && !problem && <p className="insp-hint" role="status">{t("loading")}</p>}
    <SelectionPanel key={JSON.stringify(target)} sourceTarget={target} libraryId={source.libraryId}
      selected={new Set([source.imageId])} scope={{ kind: "all" }}
      safeMode={safe} reloadKey={reloadKey} generation={reloadKey} onError={onError}
      onClear={onClose} onSourceChanged={onChanged} onAvailable={setAvailable} />
    {available && <div className="insp-foot">
      <button type="button" className="k-btn is-sm is-ghost" onClick={()=>setCopying(true)}><Copy size={14} aria-hidden="true" /><span className="k-label">{t("copyTo")}</span></button>
    </div>}
    {copying&&<SaveDestinationDialog title={t("copyTitle")} confirmLabel={t("copyConfirm")} onClose={()=>setCopying(false)} onConfirm={async destination=>{
      await workspaceCopySource(target,destination,safe);if(current.current===key){setNotice(t("copied"));onChanged?.();}
    }}/>}
  </div>;
}
