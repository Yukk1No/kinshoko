import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApplicationSettingsRestored } from "../bindings/ApplicationSettingsRestored";
import type { SafeModeScope } from "../bindings/SafeModeScope";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import type { TagDisplay } from "../bindings/TagDisplay";
import type { UpdateChannel } from "../bindings/UpdateChannel";
import {
  errorText,
  rebindShortcut,
  restoreApplicationSettings,
  setAutostart,
  setForceSrgb,
  setKeepSelectionOnSafeMode,
  setPinEdgeContrast,
  setRunLog,
  setSafeModeScope,
  setShowApproxSource,
  setTagDisplay,
  setUpdateChannel,
  shellSettings,
} from "../ipc";
import { createSettingsSubmitter, type SettingsCommand } from "./settingsSubmitter";

/** 设置页能提交的改动；每种怎样合并见 `shellSettingsCommand`。 */
export type ShellSettingsIntent =
  | { kind: "autostart"; on: boolean }
  | { kind: "showApproxSource"; on: boolean }
  | { kind: "keepSelectionOnSafeMode"; on: boolean }
  | { kind: "pinEdgeContrast"; on: boolean }
  | { kind: "runLog"; on: boolean }
  | { kind: "forceSrgb"; on: boolean }
  | { kind: "safeModeScope"; scope: SafeModeScope }
  | { kind: "tagDisplay"; display: TagDisplay }
  | { kind: "shortcut"; action: ShortcutAction; accelerator: string | null }
  | { kind: "updateChannel"; channel: UpdateChannel };

type Command = SettingsCommand<ShellSettingsView>;

/** 开关与单选：值就是最终结果，排着没发的只留最后一次。 */
const latest = (key: string, run: () => Promise<ShellSettingsView>): Command => ({ key, merge: "latest", run });

/**
 * 每种改动的合并策略。
 * - 开关、安全模式范围：只留最后一次。
 * - 标签外观：连着改只发最新的一份；失败时排着的也作废，因为它们夹带了失败的那项。
 * - 快捷键：每次更换都执行，核心逐次检查冲突并报原因。
 * - 更新通道：每次都执行，成功后设置页按新通道重新检查。
 */
export function shellSettingsCommand(intent: ShellSettingsIntent): Command {
  switch (intent.kind) {
    case "autostart": return latest(intent.kind, () => setAutostart(intent.on));
    case "showApproxSource": return latest(intent.kind, () => setShowApproxSource(intent.on));
    case "keepSelectionOnSafeMode": return latest(intent.kind, () => setKeepSelectionOnSafeMode(intent.on));
    case "pinEdgeContrast": return latest(intent.kind, () => setPinEdgeContrast(intent.on));
    case "runLog": return latest(intent.kind, () => setRunLog(intent.on));
    case "forceSrgb": return latest(intent.kind, () => setForceSrgb(intent.on));
    case "safeModeScope": return latest(intent.kind, () => setSafeModeScope(intent.scope));
    case "tagDisplay": return { key: intent.kind, merge: "latest", dropPendingOnFailure: true, run: () => setTagDisplay(intent.display) };
    case "shortcut": return { key: `shortcut/${intent.action}`, merge: "keep", run: () => rebindShortcut(intent.action, intent.accelerator) };
    case "updateChannel": return { key: intent.kind, merge: "keep", run: () => setUpdateChannel(intent.channel) };
  }
}

const LOAD = "load";

/**
 * 设置页的应用壳设置：读取、提交改动与恢复备份都经同一个提交模型（见 settingsSubmitter）。
 * `onChange` 按接受的顺序收到每份写入或恢复后的快照（读取不算）。
 */
export function useShellSettings(onChange?: (view: ShellSettingsView) => void) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const [submitter] = useState(() => createSettingsSubmitter<ShellSettingsView>({
    describe: errorText,
    onAccepted: (view, command) => { if (command.key !== LOAD) onChangeRef.current?.(view); },
  }));
  const state = useSyncExternalStore(submitter.subscribe, submitter.state);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void submitter.submit({ key: LOAD, merge: "keep", quiet: true, run: shellSettings }).then((result) => {
      if (alive && !result.ok) setLoadError(String(result.reason));
    });
    return () => { alive = false; };
  }, [submitter, loadAttempt]);

  /** 提交一项改动；返回是否保存成功（被合并的随合并后那次的结果）。失败时原因进 `error`。 */
  const submit = useCallback(
    (intent: ShellSettingsIntent) => submitter.submit(shellSettingsCommand(intent)).then((result) => result.ok),
    [submitter],
  );

  /** 用备份整份替换偏好设置；失败时 reject，原因由调用方显示。 */
  const restore = useCallback(async (path: string, fingerprint: string) => {
    let restored: ApplicationSettingsRestored | undefined;
    const result = await submitter.submit({
      key: "restore", merge: "keep", replaces: true, quiet: true,
      run: async () => (restored = await restoreApplicationSettings(path, fingerprint)).settings,
    });
    if (!result.ok) throw result.reason;
    return restored!;
  }, [submitter]);

  return {
    view: state.view,
    error: state.error,
    /** 恢复备份的代次，换了时各分区重新挂载。 */
    generation: state.generation,
    loadError,
    retryLoad: () => setLoadAttempt((n) => n + 1),
    submit,
    restore,
    showError: submitter.showError,
  };
}
