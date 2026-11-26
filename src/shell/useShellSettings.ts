import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApplicationSettingsRestored } from "../bindings/ApplicationSettingsRestored";
import type { SafeModeScope } from "../bindings/SafeModeScope";
import type { SettingChange } from "../bindings/SettingChange";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import type { TagDisplay } from "../bindings/TagDisplay";
import type { UpdateChannel } from "../bindings/UpdateChannel";
import {
  errorText,
  changeSetting,
  onSafeModeSetting,
  rebindShortcut,
  restoreApplicationSettings,
  safeMode,
  setRunLog,
  setSafeModeScope,
  setShortcutsPaused,
  setUpdateChannel,
  shellSettings,
} from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { DEFAULT_TAG_DISPLAY } from "../tags/tagConfidence";
import { createSettingsSubmitter, type SettingsCommand, type SubmitterState } from "./settingsSubmitter";

const SAFE_MODE_KEY = "safe-mode-setting";

type SafeModeSetting = { on: boolean; generation: number };

/**
 * 安全模式开关的本机设置镜像；事件带着保存后的布尔值，直接接受，迟到的旧读取不能盖掉它。
 * 后端每次提交都推进视角代次，但事件不带这个代次；这里按本代订阅收到的事件计数，
 * 让快速来回切换即使净开关不变，下游查询键也一定更换。
 */
const safeModeMirror = createBackendMirror<typeof SAFE_MODE_KEY, SafeModeSetting>({
  read: async () => ({ on: await safeMode(), generation: 0 }),
  listen: (_invalidate, accept) => {
    let generation = 0;
    return onSafeModeSetting((on) => accept(SAFE_MODE_KEY, { on, generation: ++generation }));
  },
});

/** 安全模式开关与提交代次。只在读取本机设置与跟随设置事件时使用；主窗口的切换确认流程仍在 `useSafeMode`。 */
export function useSafeModeSetting() {
  return useBackendMirror(safeModeMirror, SAFE_MODE_KEY);
}

/**
 * 设置页直接交给统一改动入口、值就是最终结果的那几项。`SettingChange` 新加的分支自动在内；
 * 标签外观另有合并规则（见下），查看器背景与详情面板不经设置页。
 */
type SettingSwitch = Exclude<
  SettingChange,
  { kind: "tagDisplay" | "viewerBackground" | "inspectorWidth" | "inspectorOpen" | "wallDensity" }
>;

/** 设置页能提交的改动；每种怎样合并见 `shellSettingsCommand`。 */
export type ShellSettingsIntent =
  | SettingSwitch
  | { kind: "runLog"; on: boolean }
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
 * - 开关、安全模式范围：只留最后一次。走统一改动入口的开关共用最后一个分支。
 * - 标签外观：连着改只发最新的一份；失败时排着的也作废，因为它们夹带了失败的那项。
 * - 快捷键：每次更换都执行，核心逐次检查冲突并报原因。
 * - 更新通道：每次都执行，成功后设置页按新通道重新检查。
 */
export function shellSettingsCommand(intent: ShellSettingsIntent, accepted: () => ShellSettingsView | null): Command {
  switch (intent.kind) {
    case "runLog":
      return latest(intent.kind, () => setRunLog(intent.on));
    case "safeModeScope":
      return latest(intent.kind, () => setSafeModeScope(intent.scope));
    case "tagDisplay":
      return {
        key: intent.kind,
        merge: "latest",
        dropPendingOnFailure: true,
        run: () =>
          changeSetting({
            kind: "tagDisplay",
            display: { ...(accepted()?.tagDisplay ?? DEFAULT_TAG_DISPLAY), ...intent.change },
          }),
      };
    case "shortcut":
      return {
        key: `shortcut/${intent.action}`,
        merge: "keep",
        run: () => rebindShortcut(intent.action, intent.accelerator),
      };
    case "updateChannel":
      return { key: intent.kind, merge: "keep", run: () => setUpdateChannel(intent.channel) };
    default:
      return latest(intent.kind, () => changeSetting(intent));
  }
}

const LOAD = "load";

/**
 * 应用壳设置的提交模型与标签外观草稿。由主窗口持有，关掉再打开设置也共用同一个队列，
 * 设置页卸载时排着的改动照样按次序执行，重新打开的设置页排在它们之后。
 * `onChange` 按接受的顺序收到每份写入或恢复后的快照（读取不算），设置页开没开着都一样。
 */
export function createShellSettings(onChange?: (view: ShellSettingsView) => void) {
  const loadMirror = createBackendMirror<typeof LOAD, ShellSettingsView>({
    read: async () => {
      const result = await load();
      if (!result.ok) throw result.reason;
      return submitter.state().view!;
    },
  });
  const submitter = createSettingsSubmitter<ShellSettingsView>({
    describe: errorText,
    onAccepted: (view, command) => {
      loadMirror.accept(LOAD, view);
      if (command.key !== LOAD && command.key !== "wallDensity") onChange?.(view);
    },
  });
  const load = () => submitter.submit({ key: LOAD, merge: "keep", quiet: true, run: shellSettings });
  // 标签外观连着改时，后一项在最后改成的那份之上改。草稿放在这里而不在外观分区里，
  // 切走再回来的分区接着在它之上改，失败作废的同项改动也就都是真依赖失败那次的。
  // 命令只带改了的几项，执行时才叠到已接受的设置上（见 shellSettingsCommand）。
  // - tagQueued：还没开始执行的那条累计的改动，新改动与它合并时要带上前面几次的。
  // - tagShown：界面上叠在已接受设置之上的改动，只含最近一次恢复之后的；全回来、开始恢复，
  //   或同一段（tagSegment，每次恢复加一）里的改动失败时清掉。别段的失败不碰它。
  // 恢复把两者都截断：恢复之后的改动另起一条，只带恢复之后改的几项，不把恢复前的其余几项写回去。
  let tagQueued: Partial<TagDisplay> | null = null;
  let tagShown: Partial<TagDisplay> | null = null;
  let tagSegment = 0;
  let tagOutstanding = 0;
  let densityDraft: number | null = null;
  let densityRevision = 0;
  const tagDraft = () => tagShown && { ...(submitter.state().view?.tagDisplay ?? DEFAULT_TAG_DISPLAY), ...tagShown };
  const listeners = new Set<() => void>();
  let snapshot: SubmitterState<ShellSettingsView> & { tagDraft: TagDisplay | null; densityDraft: number | null } = {
    ...submitter.state(),
    tagDraft: null,
    densityDraft: null,
  };
  const refresh = () => {
    snapshot = { ...submitter.state(), tagDraft: tagDraft(), densityDraft };
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
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    loadMirror,
    submit,
    changeWallDensity(density: number) {
      const revision = ++densityRevision;
      densityDraft = density;
      refresh();
      void submitter
        .submit({
          key: "wallDensity",
          merge: "latest",
          quiet: true,
          run: () => changeSetting({ kind: "wallDensity", density }),
        })
        .then((result) => {
          if (result.ok && revision === densityRevision) densityDraft = null;
          refresh();
        });
    },
    changeTagDisplay(change: Partial<TagDisplay>) {
      tagShown = { ...tagShown, ...change };
      const queued = (tagQueued = { ...tagQueued, ...change });
      const segment = tagSegment;
      tagOutstanding += 1;
      refresh();
      const command = shellSettingsCommand({ kind: "tagDisplay", change: queued }, () => submitter.state().view);
      void submitter
        .submit({
          ...command,
          run: () => {
            if (tagQueued === queued) tagQueued = null;
            return command.run();
          },
        })
        .then((result) => {
          if (!result.ok) {
            if (tagQueued === queued) tagQueued = null;
            if (segment === tagSegment) tagShown = null;
          }
          tagOutstanding -= 1;
          if (tagOutstanding === 0) tagShown = null;
          refresh();
        });
    },
    /** 用备份整份替换偏好设置；失败时 reject，原因由调用方显示。 */
    async restore(path: string, fingerprint: string) {
      let restored: ApplicationSettingsRestored | undefined;
      densityDraft = null;
      densityRevision += 1;
      tagQueued = tagShown = null;
      tagSegment += 1;
      refresh();
      const result = await submitter.submit({
        key: "restore",
        merge: "keep",
        replaces: true,
        quiet: true,
        run: async () => (restored = await restoreApplicationSettings(path, fingerprint)).settings,
      });
      if (!result.ok) throw result.reason;
      return restored!;
    },
    /**
     * 录新快捷键期间暂停或恢复全局快捷键，排在其余改动之后。恢复时没能重新注册的键随返回的设置显示出来；
     * 成功不清掉录制冲突的提示，失败时 reject，原因由调用方显示。
     */
    async pauseShortcuts(paused: boolean) {
      const result = await submitter.submit({
        key: "shortcutsPaused",
        merge: "keep",
        quiet: true,
        run: () => setShortcutsPaused(paused),
      });
      if (!result.ok) throw result.reason;
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
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const [store] = useState(() => shared ?? createShellSettings((view) => onChangeRef.current?.(view)));
  const state = useSyncExternalStore(store.subscribe, store.state);
  const load = useBackendMirror(store.loadMirror, LOAD);
  const loadError = !load.refreshing && load.error !== null ? errorText(load.error) : null;

  return {
    view: state.view,
    error: state.error,
    /** 恢复备份的代次，换了时各分区重新挂载。 */
    generation: state.generation,
    /** 标签外观：还有没回来的保存时是最后改成的那份，都回来后是已接受的设置，失败时也就回到了它。 */
    tagDisplay: state.tagDraft ?? state.view?.tagDisplay ?? DEFAULT_TAG_DISPLAY,
    changeTagDisplay: store.changeTagDisplay,
    loadError,
    retryLoad: () => store.loadMirror.invalidate(LOAD),
    submit: store.submit,
    restore: store.restore,
    pauseShortcuts: store.pauseShortcuts,
    showError: store.showError,
  };
}
