import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { DEFAULT_TAG_DISPLAY } from "../tags/tagConfidence";
import { createSettingsSubmitter, type SettingsCommand, type SubmitterState } from "./settingsSubmitter";

/** 设置页能提交的改动；每种怎样合并见 `shellSettingsCommand`。 */
export type ShellSettingsIntent =
  | { kind: "autostart"; on: boolean }
  | { kind: "showApproxSource"; on: boolean }
  | { kind: "keepSelectionOnSafeMode"; on: boolean }
  | { kind: "pinEdgeContrast"; on: boolean }
  | { kind: "runLog"; on: boolean }
  | { kind: "forceSrgb"; on: boolean }
  | { kind: "safeModeScope"; scope: SafeModeScope }
  /** 只带改了的几项：执行时才叠到已接受的标签外观上，排在恢复之后的改动不会把恢复前的其余几项写回去。 */
  | { kind: "tagDisplay"; change: Partial<TagDisplay> }
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
export function shellSettingsCommand(intent: ShellSettingsIntent, accepted: () => ShellSettingsView | null): Command {
  switch (intent.kind) {
    case "autostart": return latest(intent.kind, () => setAutostart(intent.on));
    case "showApproxSource": return latest(intent.kind, () => setShowApproxSource(intent.on));
    case "keepSelectionOnSafeMode": return latest(intent.kind, () => setKeepSelectionOnSafeMode(intent.on));
    case "pinEdgeContrast": return latest(intent.kind, () => setPinEdgeContrast(intent.on));
    case "runLog": return latest(intent.kind, () => setRunLog(intent.on));
    case "forceSrgb": return latest(intent.kind, () => setForceSrgb(intent.on));
    case "safeModeScope": return latest(intent.kind, () => setSafeModeScope(intent.scope));
    case "tagDisplay": return { key: intent.kind, merge: "latest", dropPendingOnFailure: true, run: () => setTagDisplay({ ...(accepted()?.tagDisplay ?? DEFAULT_TAG_DISPLAY), ...intent.change }) };
    case "shortcut": return { key: `shortcut/${intent.action}`, merge: "keep", run: () => rebindShortcut(intent.action, intent.accelerator) };
    case "updateChannel": return { key: intent.kind, merge: "keep", run: () => setUpdateChannel(intent.channel) };
  }
}

const LOAD = "load";

/**
 * 应用壳设置的提交模型与标签外观草稿。由主窗口持有，关掉再打开设置也共用同一个队列，
 * 设置页卸载时排着的改动照样按次序执行，重新打开的设置页排在它们之后。
 * `onChange` 按接受的顺序收到每份写入或恢复后的快照（读取不算），设置页开没开着都一样。
 */
export function createShellSettings(onChange?: (view: ShellSettingsView) => void) {
  const submitter = createSettingsSubmitter<ShellSettingsView>({
    describe: errorText,
    onAccepted: (view, command) => { if (command.key !== LOAD) onChange?.(view); },
  });
  // 标签外观连着改时，后一项在最后改成的那份之上改。草稿放在这里而不在外观分区里，
  // 切走再回来的分区接着在它之上改，失败作废的同项改动也就都是真依赖失败那次的。
  // 命令只带改了的几项，执行时才叠到已接受的设置上（见 shellSettingsCommand）。
  // - tagQueued：还没开始执行的那条累计的改动，新改动与它合并时要带上前面几次的。
  // - tagShown：界面上叠在已接受设置之上的改动；全回来、失败或开始恢复时清掉。
  // 恢复把两者都截断：恢复之后的改动另起一条，只带恢复之后改的几项，不把恢复前的其余几项写回去。
  let tagQueued: Partial<TagDisplay> | null = null;
  let tagShown: Partial<TagDisplay> | null = null;
  let tagOutstanding = 0;
  const tagDraft = () => (tagShown && { ...(submitter.state().view?.tagDisplay ?? DEFAULT_TAG_DISPLAY), ...tagShown });
  const listeners = new Set<() => void>();
  let snapshot: SubmitterState<ShellSettingsView> & { tagDraft: TagDisplay | null } = { ...submitter.state(), tagDraft: null };
  const refresh = () => {
    snapshot = { ...submitter.state(), tagDraft: tagDraft() };
    for (const listener of listeners) listener();
  };
  submitter.subscribe(refresh);

  /** 提交一项改动；返回是否保存成功（被合并的随合并后那次的结果）。失败时原因进 `error`。 */
  const submit = (intent: ShellSettingsIntent) =>
    submitter.submit(shellSettingsCommand(intent, () => submitter.state().view)).then((result) => result.ok);

  return {
    state: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load: () => submitter.submit({ key: LOAD, merge: "keep", quiet: true, run: shellSettings }),
    submit,
    changeTagDisplay(change: Partial<TagDisplay>) {
      tagShown = { ...tagShown, ...change };
      const queued = tagQueued = { ...tagQueued, ...change };
      tagOutstanding += 1;
      refresh();
      const command = shellSettingsCommand({ kind: "tagDisplay", change: queued }, () => submitter.state().view);
      void submitter.submit({ ...command, run: () => { if (tagQueued === queued) tagQueued = null; return command.run(); } }).then((result) => {
        if (!result.ok) {
          if (tagQueued === queued) tagQueued = null;
          tagShown = null;
        }
        tagOutstanding -= 1;
        if (tagOutstanding === 0) tagShown = null;
        refresh();
      });
    },
    /** 用备份整份替换偏好设置；失败时 reject，原因由调用方显示。 */
    async restore(path: string, fingerprint: string) {
      let restored: ApplicationSettingsRestored | undefined;
      tagQueued = tagShown = null;
      refresh();
      const result = await submitter.submit({
        key: "restore", merge: "keep", replaces: true, quiet: true,
        run: async () => (restored = await restoreApplicationSettings(path, fingerprint)).settings,
      });
      if (!result.ok) throw result.reason;
      return restored!;
    },
    showError: submitter.showError,
  };
}

export type ShellSettings = ReturnType<typeof createShellSettings>;

/**
 * 设置页用的应用壳设置：每次挂载都重新读一次（排在还没执行完的改动之后）。
 * 没有传入主窗口持有的 `shared` 时自己建一个，快照交给 `onChange`。
 */
export function useShellSettings(shared?: ShellSettings, onChange?: (view: ShellSettingsView) => void) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const [store] = useState(() => shared ?? createShellSettings((view) => onChangeRef.current?.(view)));
  const state = useSyncExternalStore(store.subscribe, store.state);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void store.load().then((result) => {
      if (alive && !result.ok) setLoadError(String(result.reason));
    });
    return () => { alive = false; };
  }, [store, loadAttempt]);

  return {
    view: state.view,
    error: state.error,
    /** 恢复备份的代次，换了时各分区重新挂载。 */
    generation: state.generation,
    /** 标签外观：还有没回来的保存时是最后改成的那份，都回来后是已接受的设置，失败时也就回到了它。 */
    tagDisplay: state.tagDraft ?? state.view?.tagDisplay ?? DEFAULT_TAG_DISPLAY,
    changeTagDisplay: store.changeTagDisplay,
    loadError,
    retryLoad: () => setLoadAttempt((n) => n + 1),
    submit: store.submit,
    restore: store.restore,
    showError: store.showError,
  };
}
