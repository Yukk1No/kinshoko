import { useTranslation } from "react-i18next";
import { errorText } from "../ipc";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import { SelectionPanel } from "./SelectionPanel";

/** 一份来源的详情（#98）：普通详情面板，标签、分级与备注都只改这一份；读写失败的原因留在面板里。 */
export function WorkspaceSourceEditor({ source, safe, reloadKey, onClose }: {
  source: WorkspaceSource; safe: boolean; reloadKey: number; onClose: () => void;
}) {
  const { t } = useTranslation("inspector", { keyPrefix: "source" });
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setProblem(null), [source.libraryId, source.imageId, safe, reloadKey]);
  const onError = useCallback((e: unknown) => setProblem(errorText(e)), []);
  return <div className="workspace-source-editor" aria-label={t("label")} title={source.libraryId + "/" + source.imageId}>
    {problem && <p className="insp-problem" role="alert">{problem}</p>}
    <SelectionPanel libraryId={source.libraryId} selected={new Set([source.imageId])}
      safeMode={safe} reloadKey={reloadKey} generation={reloadKey} onError={onError} onClear={onClose} />
  </div>;
}
