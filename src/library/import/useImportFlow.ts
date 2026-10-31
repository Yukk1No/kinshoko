import { useEffect, useRef, useState } from "react";
import type { EagleLibraryCandidate } from "../../bindings/EagleLibraryCandidate";
import type { EagleLocationChoice } from "../../bindings/EagleLocationChoice";
import type { EagleRelocation } from "../../bindings/EagleRelocation";
import type { ImportOptions } from "../../bindings/ImportOptions";
import type { RecoveryReport } from "../../bindings/RecoveryReport";
import type { SaveDestination } from "../../bindings/SaveDestination";
import { confirmEagleLocation, discoverEagleLibraries, importContainsEagle, libraryRecovery, onFileDrop, pickFiles, pickFolder, startImport } from "../../ipc";
import type { ImportPlan, ImportTask } from "./report";

/**
 * 开始一次导入的流程（#98、#388）：选文件或文件夹、拖进窗口、找 Eagle 库，经同一只读预检后在确认对话框里选位置；
 * 失败重试、重新导入中断的文件与确认 Eagle 搬家也走这里。打开图库时读上次中断的对账结果。
 */
export function useImportFlow({ enabled, libraryId, destination, destinationReady, busyElsewhere, onStarted, onRetryDestination }: {
  enabled: boolean;
  /** 保存位置所在的图库（没选时为空串）。 */
  libraryId: string;
  destination: SaveDestination | null | undefined;
  destinationReady: boolean;
  /** 有导入正在进行：不能开始新的。 */
  busyElsewhere: boolean;
  onStarted: (taskId: string, destination: SaveDestination) => void;
  onRetryDestination?: (destination: SaveDestination) => void;
}) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [eagleLibraries, setEagleLibraries] = useState<EagleLibraryCandidate[] | null>(null);
  const [lookingForEagle, setLookingForEagle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const optionsByTask = useRef(new Map<string, ImportOptions>());
  /**
   * 从 Eagle 迁入的任务 id；它结束后进入“标签的外部对应”一步。结束事件可能先于启动命令的
   * 响应到达，所以按 task id 把来源与终态对上，哪个先到都只打开一次（#77 UI-E）。
   */
  const [eagleTasks, setEagleTasks] = useState<ReadonlySet<string>>(() => new Set());
  // 已确认过的搬家提议，不再重复询问。
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const busy = busyElsewhere || preparing || plan !== null;
  // 切换资料库后旧工作区已卸下；新建表单打开时工作区只是隐藏，不接受导入。
  const alive = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!enabled) setHovering(false); }, [enabled]);

  const start = async (paths: string[], fromEagle = false, options?: ImportOptions, fixed?: SaveDestination) => {
    if (!alive.current || !enabledRef.current || !paths.length) return;
    try {
      setError(null);
      const target = fixed ?? destination ?? { libraryId, folderId: null };
      const taskId = await startImport(target.libraryId, paths, options, fixed ?? destination ?? undefined);
      if (!alive.current) return;
      if (options) optionsByTask.current.set(taskId, options);
      if (fromEagle) setEagleTasks((tasks) => new Set(tasks).add(taskId));
      onStarted(taskId, target);
      setPlan(null);
      setEagleLibraries(null);
    } catch (e) {
      if (alive.current) setError(`无法开始导入：${String(e)}`);
    }
  };
  // 手选、拖入、恢复中断与失败重试都经过同一只读预检；取消选择不会启动任务或写入来源。
  const begin = async (paths: string[], fromEagle = false, options?: ImportOptions, fixed?: SaveDestination) => {
    if (!alive.current || !enabledRef.current || !paths.length) return;
    if (fixed) onRetryDestination?.(fixed);
    setPreparing(true);
    setError(null);
    try {
      const isEagle = fromEagle || await importContainsEagle(paths);
      if (!alive.current || !enabledRef.current) return;
      if (isEagle || destination !== undefined) setPlan({ paths, options: options ?? { eagleDeletedContent: "skipDeleted" }, eagle: isEagle });
      else await start(paths, false, options, fixed);
    } catch (e) {
      if (alive.current) setError(`无法检查导入来源：${String(e)}`);
    } finally {
      if (alive.current) setPreparing(false);
    }
  };
  const startPlan = async () => {
    if (!plan || busyElsewhere || preparing || !destinationReady) return;
    setPreparing(true);
    await start(plan.paths, plan.eagle, plan.options, destination ?? undefined);
    if (alive.current) setPreparing(false);
  };
  const files = async () => begin(await pickFiles());
  const folder = async (fromEagle = false) => { const picked = await pickFolder(); await begin(picked ? [picked] : [], fromEagle); };
  const findEagle = async () => {
    setLookingForEagle(true);
    setError(null);
    try {
      const found = await discoverEagleLibraries();
      if (alive.current) setEagleLibraries(found);
    } catch (e) {
      if (alive.current) setError(`无法查找 Eagle 库：${String(e)}`);
    } finally {
      if (alive.current) setLookingForEagle(false);
    }
  };
  /** 重试一条任务里读取失败的项、或这次也导入删过的图：沿用它的选项与保存位置。 */
  const retry = (task: ImportTask, paths: string[], fromEagle: boolean) =>
    begin(paths, fromEagle, optionsByTask.current.get(task.taskId), task.destination);

  // 拖放的回调只注册一次，经 ref 读到最新的状态。
  const latest = useRef({ busy, begin });
  latest.current = { busy, begin };
  useEffect(() => {
    const unlisten = onFileDrop((drop) => {
      if (!alive.current || !enabledRef.current) return;
      switch (drop.kind) {
        case "enter": setHovering(!latest.current.busy); break;
        case "drop":
          setHovering(false);
          if (!latest.current.busy) void latest.current.begin(drop.paths);
          break;
        case "leave": setHovering(false); break;
      }
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  useEffect(() => {
    let current = true;
    libraryRecovery(libraryId).then((value) => current && setRecovery(value), () => {});
    return () => { current = false; };
  }, [libraryId]);

  const confirmRelocation = async (task: ImportTask, relocation: EagleRelocation, choice: EagleLocationChoice) => {
    try {
      setError(null);
      await confirmEagleLocation(task.destination?.libraryId ?? libraryId, relocation.to, choice);
      if (!alive.current) return;
      setConfirmed((done) => [...done, relocation.to]);
      await begin([relocation.to], true, optionsByTask.current.get(task.taskId), task.destination);
    } catch (e) {
      if (alive.current) setError(`无法确认 Eagle 库的位置：${String(e)}`);
    }
  };
  /** 推迟回答（Esc 或关掉对话框）：这次不导入那个位置，也不记住选择。 */
  const postponeRelocation = (relocation: EagleRelocation) => setConfirmed((done) => [...done, relocation.to]);

  return {
    plan, setPlan, preparing, startPlan, busy, lookingForEagle, hovering,
    eagleLibraries, setEagleLibraries, findEagle, files, folder, begin, retry,
    error, clearError: () => setError(null), recovery, clearRecovery: () => setRecovery(null),
    eagleTasks, confirmed, confirmRelocation, postponeRelocation,
  };
}
