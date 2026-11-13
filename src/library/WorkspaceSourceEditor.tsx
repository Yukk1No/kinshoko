import { useTranslation } from "react-i18next";
import { errorText } from "../ipc";
import { useCallback } from "react";
import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import { useToast } from "../ui/Toast";
import { SelectionPanel } from "./SelectionPanel";

/** 一份来源的详情（#98）：普通详情面板，标签、分级与备注都只改这一份。 */
export function WorkspaceSourceEditor({
  source,
  safe,
  reloadKey,
  onClose,
}: {
  source: WorkspaceSource;
  safe: boolean;
  reloadKey: number;
  onClose: () => void;
}) {
  const { t } = useTranslation("inspector", { keyPrefix: "source" });
  const toast = useToast();
  const onError = useCallback(
    (e: unknown) => {
      toast.error(errorText(e));
    },
    [toast],
  );
  return (
    <div className="workspace-source-editor" aria-label={t("label")}>
      <SelectionPanel
        libraryId={source.libraryId}
        selected={new Set([source.imageId])}
        safeMode={safe}
        reloadKey={reloadKey}
        generation={reloadKey}
        onError={onError}
        onClear={onClose}
      />
    </div>
  );
}
