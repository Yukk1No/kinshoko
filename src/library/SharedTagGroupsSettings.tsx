import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isLensChanged } from "../ipc";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { useSafeModeSetting } from "../shell/useShellSettings";
import { workspaceStatusKey, workspaceStatusMirror } from "../workspace/workspaceStatusMirror";
import { TagGroupsPane } from "./TagGroupsPane";

/** The same application configuration editor is available without a current library. */
export function SharedTagGroupsSettings({ onError }: { onError: (error: unknown) => void }) {
  const { t } = useTranslation("tagGroups");
  const safeMode = useSafeModeSetting();
  const safe = safeMode.value?.on ?? null;
  const safeGeneration = safeMode.value?.generation ?? 0;
  const workspace = useBackendMirror(workspaceStatusMirror, workspaceStatusKey(safe ?? true), safe !== null);
  const revision = workspace.value?.revision ?? null;
  const workspaceSettled = workspace.value !== null || workspace.error !== null;
  const [baselineReady, setBaselineReady] = useState(false);
  const [monitor, setMonitor] = useState<{
    safe: boolean | null;
    safeGeneration: number;
    revision: string | null;
    generation: number;
  }>({ safe: null, safeGeneration: 0, revision: null, generation: 0 });
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  // 工作区镜像已经收拢读取、事件退订与防乱序；这里只把“安全模式视角 + 修订”译成分组编辑器要的数字代次。
  // 在这次渲染里推进：视角来回切换即使净结果不变也作废旧读取，修订变化不会先画出一帧旧分组。
  if (safe !== monitor.safe || safeGeneration !== monitor.safeGeneration || revision !== monitor.revision) {
    const lensChangedHere =
      monitor.safe !== null && (safe !== monitor.safe || safeGeneration !== monitor.safeGeneration);
    const contentChanged = revision !== null && revision !== monitor.revision;
    setMonitor({
      safe,
      safeGeneration,
      revision,
      generation: monitor.generation + (lensChangedHere || contentChanged ? 1 : 0),
    });
  }

  useEffect(() => {
    if (workspaceSettled) setBaselineReady(true);
  }, [workspaceSettled]);

  useEffect(() => {
    if (safeMode.error !== null) onErrorRef.current(safeMode.error);
  }, [safeMode.error]);
  useEffect(() => {
    if (workspace.error !== null && !isLensChanged(workspace.error)) onErrorRef.current(workspace.error);
  }, [workspace.error]);

  return (
    <>
      {safe === null || !baselineReady ? (
        <p role="status">{t("settingsLoading")}</p>
      ) : (
        <TagGroupsPane label={t("settingsLabel")} safe={safe} generation={monitor.generation} onError={onError} />
      )}
    </>
  );
}
