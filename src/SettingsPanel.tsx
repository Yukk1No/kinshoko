import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useTranslation } from "react-i18next";
import { Activity, Archive, FileText, Keyboard, Layers, Monitor, MousePointerClick, Pin, Power, RefreshCw, Scaling, Settings2, ShieldCheck, Sparkles, Tags } from "lucide-react";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { SafeModeScope } from "./bindings/SafeModeScope";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { ShortcutBinding } from "./bindings/ShortcutBinding";
import { clearRunLog, errorText, hotkeyFailureText } from "./ipc";
import { useShellSettings, type ShellSettings, type ShellSettingsIntent } from "./shell/useShellSettings";
import { SharedPersonalApproxSettings } from "./search/SharedPersonalApproxSettings";
import { LegacyNameBanner } from "./library/LegacyNameMigrationPanel";
import { SharedTagGroupsSettings } from "./library/TagGroupsPane";
import { TagNamePanel } from "./library/TagNamePanel";
import { TagIdentityPanel } from "./library/TagIdentityPanel";
import { ApplicationSettingsBackup } from "./ApplicationSettingsBackup";
import { TagDisplaySettings } from "./TagDisplaySettings";
import { BackupSettings } from "./Backup";
import { AutoTaggingSettings } from "./AutoTaggingSettings";
import { UpdateSection } from "./Update";
import { RuntimeDetails, useDiagnosticsReport } from "./RuntimeSupport";
import { Segmented } from "./ui/Segmented";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";
import { Switch } from "./ui/Switch";
import { SealLock } from "./ui/SealLock";
import { UI_SCALE_LEVELS } from "./shell/uiScale";
import { Select } from "./ui/Select";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

/**
 * 把一次按键整理成全局快捷键的写法，主键用 `KeyboardEvent.code`，例如 `Ctrl+Alt+KeyA`。
 * 只按下修饰键时返回 null，继续等待主键。统一写法与合法性由核心判断。
 */
function acceleratorFromKey(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  parts.push(e.code);
  return parts.join("+");
}

/** 快捷键的显示：每个键一枚键帽，`KeyA` 写成 `A`；读屏读到的是完整写法。 */
export function Keys({ accelerator }: { accelerator: string }) {
  return <span className="k-keys" aria-label={accelerator}>{accelerator.split("+").map((key, index) =>
    <kbd key={index} className="k-key" aria-hidden="true">{key.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "")}</kbd>)}</span>;
}

/** 查看器里的固定操作（#179）：缩放、平移、框选、换图、详情侧栏与返回。按键是滚轮、拖动这类操作时写它的键名。 */
type ViewerKeyWord = "wheel" | "drag" | "shiftDrag";
const VIEWER_KEYS: [action: string, keys: string | { word: ViewerKeyWord }][] = [
  ["zoom", { word: "wheel" }], ["pan", { word: "drag" }], ["crop", { word: "shiftDrag" }], ["cropMode", "F1"], ["previous", "←"], ["next", "→"],
  ["fit", "0"], ["actual", "1"], ["pin", "P"], ["details", "I"], ["back", "Esc"],
];

export type SettingsTab = "general" | "keys" | "tags" | "tagging" | "backup" | "safety" | "update" | "diag";
const TABS: { value: SettingsTab; icon: ReactNode }[] = [
  { value: "general", icon: <Settings2 size={15} aria-hidden="true" /> },
  { value: "keys", icon: <Keyboard size={15} aria-hidden="true" /> },
  { value: "tags", icon: <Tags size={15} aria-hidden="true" /> },
  { value: "tagging", icon: <Sparkles size={15} aria-hidden="true" /> },
  { value: "backup", icon: <Archive size={15} aria-hidden="true" /> },
  { value: "safety", icon: <ShieldCheck size={15} aria-hidden="true" /> },
  { value: "update", icon: <RefreshCw size={15} aria-hidden="true" /> },
  { value: "diag", icon: <Activity size={15} aria-hidden="true" /> },
];

type TagView = "names" | "groups" | "approx" | "mapping" | "appearance";
const TAG_VIEWS: TagView[] = ["names", "groups", "approx", "mapping", "appearance"];

/** 安全模式范围（#223）的三档，从宽到严；名称与人工分级界面的分级名一致。 */
const SAFE_MODE_SCOPES: SafeModeScope[] = ["sensitive", "questionable", "explicit"];

type Props = {
  onRestored?: () => void;
  /** 打开的资料库；自动标签分页从它开始跟随后端的可写资料库。个人规则不依赖它。 */
  library?: LibraryInfo | null;
  /** 主窗口持有的设置提交模型（#321）：关掉再打开设置也共用一个队列。没有时设置页自己建一个。 */
  settings?: ShellSettings;
  /** 应用壳设置保存后的结果（只在没有传入 `settings` 时用），主窗口据此更新（例如相近标签来源标记）。 */
  onChange?: (view: ShellSettingsView) => void;
  /** 打开时所在的分页。 */
  initialTab?: SettingsTab;
  /** 打开时在 标签 › 显示名 里定位并展开的统一标签（#182）。 */
  initialTagFocus?: string;
  /** 导航底部的版本，例如“Kinshoko 0.1.2”。 */
  version?: string | null;
  /** 安全模式（主窗口持有）；没有时安全分页只说明行为。 */
  safe?: boolean;
  onSafeMode?: () => void;
  /** 打开“确认旧名称”向导（标签分页的提示条）。 */
  onOpenNameWizard?: () => void;
  /** 界面缩放档位（主窗口持有，#173）；没有时通用分页不显示这一项。 */
  uiScale?: number;
  onUiScale?: (percent: number) => void;
};

/**
 * 程序设置（#98）：竖排八个分页——通用、快捷键、标签、自动标签（#143）、备份、安全、更新、诊断。
 * 每项一行：图标 · 名称 · 一句描述 · 右侧控件。行为与原来的各节相同，只是重新归位。
 */
export function SettingsPanel({ settings: shared, onChange, onRestored, library, initialTab = "general", initialTagFocus, version, safe, onSafeMode, onOpenNameWizard, uiScale, onUiScale }: Props) {
  const { t } = useTranslation("settings");
  const settings = useShellSettings(shared, onChange);
  const { view, loadError, error, generation: settingsGeneration } = settings;
  const setError = settings.showError;
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [tagView, setTagView] = useState<TagView>("names");
  const diagnostics = useDiagnosticsReport((e) => setError(errorText(e)));

  /** 提交一项改动；返回是否成功，失败时说明原因，界面留在已接受的设置上。 */
  const apply = (intent: ShellSettingsIntent) => settings.submit(intent);

  function onRecordKey(action: ShortcutAction, e: KeyboardEvent<HTMLInputElement>) {
    e.preventDefault();
    // 录制中的 Esc 只取消录制，不关闭设置对话框。
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      return;
    }
    const accelerator = acceleratorFromKey(e);
    if (accelerator === null) return;
    setRecording(null);
    void apply({ kind: "shortcut", action, accelerator });
  }

  if (view === null) {
    return <section className="k-settings is-loading" aria-label={t("label")}>
      {loadError === null
        ? <p className="k-set-note" role="status">{t("loading")}</p>
        : <div className="k-set-load-error">
          <p className="k-set-error" role="alert">{t("loadFailed", { error: loadError })}</p>
          <button type="button" className="k-btn" onClick={settings.retryLoad}><span className="k-label">{t("retry")}</span></button>
        </div>}
    </section>;
  }
  const restore = async (path: string, fingerprint: string) => {
    const restored = await settings.restore(path, fingerprint);
    onRestored?.();
    return restored;
  };
  const page = (value: SettingsTab, children: ReactNode) => {
    return <Tabs.Panel value={value} className="k-set-page">
      <h3 className="k-set-title">{t(`tab.${value}`)}</h3>
      {error !== null && <p className="k-set-error" role="alert">{error}</p>}
      {children}
    </Tabs.Panel>;
  };

  return (
    <section className="k-settings" aria-label={t("label")}>
      <Tabs.Root value={tab} onValueChange={(next) => { setTab(next as SettingsTab); setRecording(null); setError(null); }} orientation="vertical" className="k-set-body">
        <nav className="k-set-nav">
          <h2 className="k-set-heading">{t("heading")}</h2>
          <Tabs.List className="k-set-tabs" aria-label={t("tabsLabel")}>
            {TABS.map((entry) => <Tabs.Tab key={entry.value} value={entry.value} className="k-set-tab">{entry.icon}<span className="k-label">{t(`tab.${entry.value}`)}</span></Tabs.Tab>)}
          </Tabs.List>
          <span className="k-grow" />
          {version && <p className="k-set-version">{version}</p>}
        </nav>
        <div className="k-set-main">
          {page("general", <>
            <SettingsGroup label={t("general.group")}>
              <SettingsRow icon={<Power size={16} />} title={t("general.autostart")} hint={t("general.autostartHint")}>
                <Switch label={t("general.autostart")} checked={view.autostart} onCheckedChange={(on) => void apply({ kind: "autostart", on })} />
              </SettingsRow>
              {uiScale !== undefined && onUiScale && <SettingsRow icon={<Scaling size={16} />} title={t("general.uiScale")} hint={t("general.uiScaleHint")}>
                <Select label={t("general.uiScale")} value={String(uiScale)} onChange={(value) => onUiScale(Number(value))}
                  options={UI_SCALE_LEVELS.map((percent) => ({ value: String(percent), label: `${percent}%` }))} />
              </SettingsRow>}
            </SettingsGroup>
            <SettingsGroup label={t("general.pinsGroup")}>
              <SettingsRow icon={<Pin size={16} />} title={t("general.pinEdge")} hint={t("general.pinEdgeHint")}>
                <Switch label={t("general.pinEdge")} checked={view.pinEdgeContrast} onCheckedChange={(on) => void apply({ kind: "pinEdgeContrast", on })} />
              </SettingsRow>
            </SettingsGroup>
          </>)}
          {page("keys", <><SettingsGroup label={t("keys.group")}>
            {view.shortcuts.map((binding: ShortcutBinding) => {
              const label = t(`keys.action.${binding.action}`);
              const isRecording = recording === binding.action;
              return <SettingsRow key={binding.action} label={label} title={label} className={isRecording ? "is-recording" : ""}
                warn={binding.problem !== null && t("keys.notRegistered", { reason: hotkeyFailureText(binding.problem) })}>
                {isRecording ? <>
                  <input className="k-key-recorder" aria-label={t("keys.record")} placeholder={t("keys.recordPlaceholder")} autoFocus readOnly
                    onKeyDown={(e) => onRecordKey(binding.action, e)} onBlur={() => setRecording(null)} />
                  <button type="button" className="k-btn is-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setRecording(null)}><span className="k-label">{t("keys.cancel")}</span></button>
                </> : <>
                  {binding.accelerator === null ? <span className="k-set-muted">{t("keys.unset")}</span> : <Keys accelerator={binding.accelerator} />}
                  {binding.accelerator !== null && <button type="button" className="k-btn is-sm is-quiet"
                    onClick={() => void apply({ kind: "shortcut", action: binding.action, accelerator: null })}><span className="k-label">{t("keys.clear")}</span></button>}
                  <button type="button" className="k-btn is-sm" onClick={() => setRecording(binding.action)}><span className="k-label">{binding.accelerator === null ? t("keys.set") : t("keys.change")}</span></button>
                </>}
              </SettingsRow>;
            })}
            {([["safeMode", "Ctrl+Shift+S"], ["zoomIn", "Ctrl+="], ["zoomOut", "Ctrl+-"], ["zoomReset", "Ctrl+0"]] as const).map(([action, keys]) =>
              <SettingsRow key={action} label={t(`keys.${action}`)} title={t(`keys.${action}`)} hint={t("keys.fixedHint")}><Keys accelerator={keys} /></SettingsRow>)}
          </SettingsGroup>
          {/* 查看器的操作提示（#179，原在查看器的信息浮层里）。 */}
          <SettingsGroup label={t("keys.viewerGroup")}>
            {VIEWER_KEYS.map(([action, keys]) => {
              const title = t(`keys.viewer.${action}` as "keys.viewer.zoom");
              return <SettingsRow key={action} label={title} title={title}><Keys accelerator={typeof keys === "string" ? keys : t(`keys.key.${keys.word}`)} /></SettingsRow>;
            })}
          </SettingsGroup></>)}
          {page("tags", <>
            <Segmented<TagView> className="k-set-seg" label={t("tags.viewLabel")} value={tagView} onChange={setTagView}
              options={TAG_VIEWS.map((value) => ({ value, label: t(`tags.view.${value}`) }))} />
            {tagView === "appearance" && <TagDisplaySettings key={`appearance/${settingsGeneration}`} display={settings.tagDisplay} onChange={settings.changeTagDisplay} />}
            {tagView === "names" && <>
              <TagNamePanel key={`names/${settingsGeneration}`} focus={initialTagFocus} />
              <LegacyNameBanner onOpen={onOpenNameWizard} />
            </>}
            {tagView === "groups" && <SharedTagGroupsSettings key={`groups/${settingsGeneration}`} onError={(e) => setError(errorText(e))} />}
            {tagView === "approx" && <>
              <SettingsGroup label={t("tags.approxGroup")}>
                <SettingsRow icon={<Tags size={16} />} title={t("tags.showSource")} hint={t("tags.showSourceHint")}>
                  <Switch label={t("tags.showSource")} checked={view.showApproxSource} onCheckedChange={(on) => void apply({ kind: "showApproxSource", on })} />
                </SettingsRow>
              </SettingsGroup>
              <SharedPersonalApproxSettings key={`approx/${settingsGeneration}`} onError={(e) => setError(errorText(e))} />
            </>}
            {tagView === "mapping" && <TagIdentityPanel key={`identity/${settingsGeneration}`} />}
          </>)}
          {page("tagging", <AutoTaggingSettings key={`tagging/${settingsGeneration}`} libraryId={library?.id ?? null} />)}
          {page("backup", <>
            <BackupSettings />
            <ApplicationSettingsBackup restore={restore} />
          </>)}
          {page("safety", <SettingsGroup label={t("safety.group")}>
            <SettingsRow icon={<SealLock size={10} />} title={t("safety.safeMode")} hint={t("safety.safeModeHint")}>
              <Keys accelerator="Ctrl+Shift+S" />
              {safe !== undefined && onSafeMode && <Switch label={t("safety.safeMode")} checked={safe} onCheckedChange={(on) => { if (on !== safe) onSafeMode(); }} />}
            </SettingsRow>
            <SettingsRow icon={<Layers size={16} />} title={t("safety.scope")} hint={t("safety.scopeHint")}>
              <Segmented<SafeModeScope> label={t("safety.scope")} value={view.safeModeScope ?? "questionable"}
                onChange={(scope) => void apply({ kind: "safeModeScope", scope })} options={SAFE_MODE_SCOPES.map((value) => ({ value, label: t(`safety.scopeOption.${value}`) }))} />
            </SettingsRow>
            <SettingsRow icon={<MousePointerClick size={16} />} title={t("safety.keepSelection")} hint={t("safety.keepSelectionHint")}>
              <Switch label={t("safety.keepSelection")} checked={view.keepSelectionOnSafeMode ?? false} onCheckedChange={(on) => void apply({ kind: "keepSelectionOnSafeMode", on })} />
            </SettingsRow>
            <SettingsRow icon={<ShieldCheck size={16} />} title={t("safety.groupsAndPins")} hint={t("safety.groupsAndPinsHint")}>
              <StatusPill tone={safe === false ? "plain" : "ok"}>{safe === false ? t("safety.off") : t("safety.on")}</StatusPill>
            </SettingsRow>
          </SettingsGroup>)}
          {page("update", <UpdateSection version={version ?? null} channel={view.updateChannel} onChannel={(channel) => apply({ kind: "updateChannel", channel })} />)}
          {page("diag", <>
            <RuntimeDetails />
            <SettingsGroup label={t("diag.group")}>
              <SettingsRow icon={<FileText size={16} />} title={t("diag.report")} hint={t("diag.reportHint")}
                below={<>
                  <p className="k-set-note">{t("diag.reportNote")}</p>
                  {diagnostics.text !== null && <pre className="settings-diagnostics" aria-label={t("diag.report")}>{diagnostics.text}</pre>}
                </>}>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.show}><span className="k-label">{t("diag.show")}</span></button>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.save}><span className="k-label">{t("diag.save")}</span></button>
              </SettingsRow>
              <SettingsRow icon={<Activity size={16} />} title={t("diag.runLog")} hint={t("diag.runLogHint")}
                below={<p className="k-set-note">{t("diag.runLogNote")}
                  <button type="button" className="k-link" onClick={() => void clearRunLog().catch((e) => setError(errorText(e)))}>{t("diag.clearRunLog")}</button></p>}>
                <Switch label={t("diag.runLog")} checked={view.runLog} onCheckedChange={(on) => void apply({ kind: "runLog", on })} />
              </SettingsRow>
              <SettingsRow icon={<Monitor size={16} />} title={t("diag.srgb")} hint={t("diag.srgbHint")}
                warn={view.forceSrgb !== view.forceSrgbInEffect && t("diag.restartNeeded")}>
                <Switch label={t("diag.srgb")} checked={view.forceSrgb} onCheckedChange={(on) => void apply({ kind: "forceSrgb", on })} />
              </SettingsRow>
            </SettingsGroup>
          </>)}
        </div>
      </Tabs.Root>
    </section>
  );
}
