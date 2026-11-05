import { SaveDestinationDialog } from "./SaveDestination";
import { useTranslation } from "react-i18next";
import { errorText, workspaceCopySource } from "../ipc";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import type { WorkspaceSourceInspection } from "../bindings/WorkspaceSourceInspection";
import { workspaceSourceInspection } from "../ipc";
import { SelectionPanel } from "./SelectionPanel";
import { Copy } from "lucide-react";
import { useUiLang } from "../i18n";

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
  // 整理改了这份来源后重读（#158：详情、标签与文件夹树都出自这一次来源检查）。
  const [refresh, setRefresh] = useState(0);
  const lang = useUiLang();
  const key = JSON.stringify([target, safe, reloadKey, refresh, lang]);
  const current = useRef(key); current.current = key;
  const [ready, setReady] = useState<{ key: string; value: WorkspaceSourceInspection } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copying,setCopying]=useState(false);
  useEffect(() => {
    let alive = true;
    setProblem(null); setNotice(null);
    workspaceSourceInspection(target, safe, lang).then(
      (value) => alive && setReady({ key, value }),
      (error) => { if (alive) { setReady(null); setProblem(String(error)); } },
    );
    return () => { alive = false; };
  }, [key]);
  // 重读期间留着上一次的内容（不可操作），不让面板闪成“正在读取”。
  const available = ready !== null;
  return <div className="workspace-source-editor" aria-label={t("label")} title={source.libraryId + "/" + source.imageId}>
    {problem && <p className="insp-problem" role="alert">{problem}</p>}
    {notice && <p className="insp-notice" role="status">{notice}</p>}
    {!available && !problem && <p className="insp-hint" role="status">{t("loading")}</p>}
    {available && <>
      <SelectionPanel key={JSON.stringify(target)} sourceTarget={target} libraryId={source.libraryId}
        inspection={{ value: ready.value, stale: ready.key !== key, reload: () => setRefresh((n) => n + 1) }}
        selected={new Set([source.imageId])} scope={{ kind: ready.value.detail.deletedAt !== null ? "trash" : "all" }}
        safeMode={safe} reloadKey={reloadKey} generation={reloadKey} onError={(e) => setProblem(errorText(e))}
        onClear={onClose} onSourceChanged={onChanged} />
      <div className="insp-foot">
        <button type="button" className="k-btn is-sm is-ghost" onClick={()=>setCopying(true)}><Copy size={14} aria-hidden="true" /><span className="k-label">{t("copyTo")}</span></button>
      </div>
    </>}
    {copying&&<SaveDestinationDialog title={t("copyTitle")} confirmLabel={t("copyConfirm")} onClose={()=>setCopying(false)} onConfirm={async destination=>{
      await workspaceCopySource(target,destination,safe);if(current.current===key){setNotice(t("copied"));onChanged?.();}
    }}/>}
  </div>;
}
