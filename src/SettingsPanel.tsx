import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Activity, Archive, FileText, Keyboard, Layers, Monitor, MousePointerClick, Pin, Power, RefreshCw, Scaling, Settings2, ShieldCheck, Sparkles, Tags } from "lucide-react";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { SafeModeScope } from "./bindings/SafeModeScope";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { ShortcutBinding } from "./bindings/ShortcutBinding";
import {
  clearRunLog,
  rebindShortcut,
  setAutostart,
  setForceSrgb,
  setShowApproxSource,
  setTagDisplay,
  setKeepSelectionOnSafeMode,
  setPinEdgeContrast,
  setSafeModeScope,
  setUpdateChannel,
  setRunLog,
  shellSettings,
} from "./ipc";
import { SharedPersonalApproxSettings } from "./search/SharedPersonalApproxSettings";
import { LegacyNameBanner } from "./library/LegacyNameMigrationPanel";
import { SharedTagGroupsSettings } from "./library/TagGroupsPane";
import { TagNamePanel } from "./library/TagNamePanel";
import { TagIdentityPanel } from "./library/TagIdentityPanel";
import { ApplicationSettingsBackup } from "./ApplicationSettingsBackup";
import { TagDisplaySettings } from "./TagDisplaySettings";
import { DEFAULT_TAG_DISPLAY } from "./tags/tagConfidence";
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

const ACTION_LABELS: Record<ShortcutAction, string> = {
  capture: "截图",
  pinClipboard: "钉剪贴板",
  hideAllPins: "收起钉图",
};

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

/** 查看器里的固定操作（#179）：缩放、平移、框选、换图、详情侧栏与返回。 */
const VIEWER_KEYS: [string, string][] = [
  ["缩放", "滚轮"], ["平移", "拖动"], ["框选局部", "Shift+拖动"], ["进入框选", "F1"], ["上一张", "←"], ["下一张", "→"],
  ["适应窗口", "0"], ["原始像素", "1"], ["钉住整图", "P"], ["显示或隐藏详情", "I"], ["返回图片墙", "Esc"],
];

export type SettingsTab = "general" | "keys" | "tags" | "tagging" | "backup" | "safety" | "update" | "diag";
const TABS: { value: SettingsTab; name: string; icon: ReactNode }[] = [
  { value: "general", name: "通用", icon: <Settings2 size={15} aria-hidden="true" /> },
  { value: "keys", name: "快捷键", icon: <Keyboard size={15} aria-hidden="true" /> },
  { value: "tags", name: "标签", icon: <Tags size={15} aria-hidden="true" /> },
  { value: "tagging", name: "自动标签", icon: <Sparkles size={15} aria-hidden="true" /> },
  { value: "backup", name: "备份", icon: <Archive size={15} aria-hidden="true" /> },
  { value: "safety", name: "安全", icon: <ShieldCheck size={15} aria-hidden="true" /> },
  { value: "update", name: "更新", icon: <RefreshCw size={15} aria-hidden="true" /> },
  { value: "diag", name: "诊断", icon: <Activity size={15} aria-hidden="true" /> },
];

type TagView = "names" | "groups" | "approx" | "mapping" | "appearance";

/** 安全模式范围（#223）的三档，从宽到严；名称与人工分级界面的分级名一致。 */
const SAFE_MODE_SCOPES: { value: SafeModeScope; label: string }[] = [
  { value: "sensitive", label: "轻度及以上" },
  { value: "questionable", label: "敏感及以上" },
  { value: "explicit", label: "仅成人" },
];

type Props = {
  onRestored?: () => void;
  /** 打开的资料库；自动标签分页从它开始跟随后端的可写资料库。个人规则不依赖它。 */
  library?: LibraryInfo | null;
  /** 应用壳设置保存后的结果，主窗口据此更新（例如相近标签来源标记）。 */
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
export function SettingsPanel({ onChange, onRestored, library, initialTab = "general", initialTagFocus, version, safe, onSafeMode, onOpenNameWizard, uiScale, onUiScale }: Props) {
  const [settingsGeneration, setSettingsGeneration] = useState(0);
  const [view, setView] = useState<ShellSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [tagView, setTagView] = useState<TagView>("names");
  const diagnostics = useDiagnosticsReport(setError);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    shellSettings().then(
      (value) => { if (alive) setView(value); },
      (reason) => { if (alive) setLoadError(String(reason)); },
    );
    return () => {
      alive = false;
    };
  }, [loadAttempt]);

  /** 保存一项设置；返回是否成功，失败时说明原因，界面留在原来的设置上。 */
  async function apply(change: Promise<ShellSettingsView>): Promise<boolean> {
    try {
      const next = await change;
      setView(next);
      onChange?.(next);
      setError(null);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    }
  }

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
    void apply(rebindShortcut(action, accelerator));
  }

  if (view === null) {
    return <section className="k-settings is-loading" aria-label="设置">
      {loadError === null
        ? <p className="k-set-note" role="status">正在读取设置…</p>
        : <div className="k-set-load-error">
          <p className="k-set-error" role="alert">设置没读出来：{loadError}</p>
          <button type="button" className="k-btn" onClick={() => setLoadAttempt((n) => n + 1)}>重试</button>
        </div>}
    </section>;
  }
  const restored = (next: ShellSettingsView) => { setView(next); onChange?.(next); setSettingsGeneration((generation) => generation + 1); onRestored?.(); };
  const page = (value: SettingsTab, children: ReactNode) => {
    const meta = TABS.find((entry) => entry.value === value)!;
    return <Tabs.Panel value={value} className="k-set-page">
      <h3 className="k-set-title">{meta.name}</h3>
      {error !== null && <p className="k-set-error" role="alert">{error}</p>}
      {children}
    </Tabs.Panel>;
  };

  return (
    <section className="k-settings" aria-label="设置">
      <Tabs.Root value={tab} onValueChange={(next) => { setTab(next as SettingsTab); setRecording(null); setError(null); }} orientation="vertical" className="k-set-body">
        <nav className="k-set-nav">
          <h2 className="k-set-heading">设置</h2>
          <Tabs.List className="k-set-tabs" aria-label="设置分页">
            {TABS.map((entry) => <Tabs.Tab key={entry.value} value={entry.value} className="k-set-tab">{entry.icon}{entry.name}</Tabs.Tab>)}
          </Tabs.List>
          <span className="k-grow" />
          {version && <p className="k-set-version">{version}</p>}
        </nav>
        <div className="k-set-main">
          {page("general", <>
            <SettingsGroup label="通用">
              <SettingsRow icon={<Power size={16} />} title="开机启动" hint="在托盘里待命">
                <Switch label="开机启动" checked={view.autostart} onCheckedChange={(on) => void apply(setAutostart(on))} />
              </SettingsRow>
              {uiScale !== undefined && onUiScale && <SettingsRow icon={<Scaling size={16} />} title="界面缩放" hint="只放大主窗口，钉图和截图不变">
                <Select label="界面缩放" value={String(uiScale)} onChange={(value) => onUiScale(Number(value))}
                  options={UI_SCALE_LEVELS.map((percent) => ({ value: String(percent), label: `${percent}%` }))} />
              </SettingsRow>}
            </SettingsGroup>
            <SettingsGroup label="桌面钉图">
              <SettingsRow icon={<Pin size={16} />} title="增强钉图边缘" hint="阴影外加一圈浅色细线，深色画布上更好分辨">
                <Switch label="增强钉图边缘" checked={view.pinEdgeContrast} onCheckedChange={(on) => void apply(setPinEdgeContrast(on))} />
              </SettingsRow>
            </SettingsGroup>
          </>)}
          {page("keys", <><SettingsGroup label="快捷键">
            {view.shortcuts.map((binding: ShortcutBinding) => {
              const label = ACTION_LABELS[binding.action];
              const isRecording = recording === binding.action;
              return <SettingsRow key={binding.action} label={label} title={label} className={isRecording ? "is-recording" : ""}
                warn={binding.problem !== null && `未注册：${binding.problem}`}>
                {isRecording ? <>
                  <input className="k-key-recorder" aria-label="按下新的组合键" placeholder="按下新的组合键…" autoFocus readOnly
                    onKeyDown={(e) => onRecordKey(binding.action, e)} onBlur={() => setRecording(null)} />
                  <button type="button" className="k-btn is-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setRecording(null)}>取消</button>
                </> : <>
                  {binding.accelerator === null ? <span className="k-set-muted">未设置</span> : <Keys accelerator={binding.accelerator} />}
                  {binding.accelerator !== null && <button type="button" className="k-btn is-sm is-quiet"
                    onClick={() => void apply(rebindShortcut(binding.action, null))}>清除</button>}
                  <button type="button" className="k-btn is-sm" onClick={() => setRecording(binding.action)}>{binding.accelerator === null ? "设置" : "更换"}</button>
                </>}
              </SettingsRow>;
            })}
            <SettingsRow label="安全模式" title="安全模式" hint="固定按键，在主窗口里用"><Keys accelerator="Ctrl+Shift+S" /></SettingsRow>
            <SettingsRow label="放大界面" title="放大界面" hint="固定按键，在主窗口里用"><Keys accelerator="Ctrl+=" /></SettingsRow>
            <SettingsRow label="缩小界面" title="缩小界面" hint="固定按键，在主窗口里用"><Keys accelerator="Ctrl+-" /></SettingsRow>
            <SettingsRow label="界面复位到 100%" title="界面复位到 100%" hint="固定按键，在主窗口里用"><Keys accelerator="Ctrl+0" /></SettingsRow>
          </SettingsGroup>
          {/* 查看器的操作提示（#179，原在查看器的信息浮层里）。 */}
          <SettingsGroup label="查看器">
            {VIEWER_KEYS.map(([title, keys]) => <SettingsRow key={title} label={title} title={title}><Keys accelerator={keys} /></SettingsRow>)}
          </SettingsGroup></>)}
          {page("tags", <>
            <Segmented<TagView> className="k-set-seg" label="标签设置" value={tagView} onChange={setTagView} options={[
              { value: "names", label: "显示名" }, { value: "groups", label: "分组" }, { value: "approx", label: "相近" }, { value: "mapping", label: "对应" },
              { value: "appearance", label: "外观" },
            ]} />
            {tagView === "appearance" && <TagDisplaySettings display={view.tagDisplay ?? DEFAULT_TAG_DISPLAY} onSave={(next) => apply(setTagDisplay(next))} />}
            {tagView === "names" && <>
              <TagNamePanel key={`names/${settingsGeneration}`} focus={initialTagFocus} />
              <LegacyNameBanner onOpen={onOpenNameWizard} />
            </>}
            {tagView === "groups" && <SharedTagGroupsSettings key={`groups/${settingsGeneration}`} onError={setError} />}
            {tagView === "approx" && <>
              <SettingsGroup label="相近标签">
                <SettingsRow icon={<Tags size={16} />} title="标出来源" hint="相近标签旁注明内置或个人">
                  <Switch label="标出来源" checked={view.showApproxSource} onCheckedChange={(on) => void apply(setShowApproxSource(on))} />
                </SettingsRow>
              </SettingsGroup>
              <SharedPersonalApproxSettings key={`approx/${settingsGeneration}`} onError={setError} />
            </>}
            {tagView === "mapping" && <TagIdentityPanel key={`identity/${settingsGeneration}`} />}
          </>)}
          {page("tagging", <AutoTaggingSettings key={`tagging/${settingsGeneration}`} libraryId={library?.id ?? null} />)}
          {page("backup", <>
            <BackupSettings />
            <ApplicationSettingsBackup onRestored={restored} />
          </>)}
          {page("safety", <SettingsGroup label="安全">
            <SettingsRow icon={<SealLock size={10} />} title="安全模式" hint="隐藏范围内的图，钉图里模糊">
              <Keys accelerator="Ctrl+Shift+S" />
              {safe !== undefined && onSafeMode && <Switch label="安全模式" checked={safe} onCheckedChange={(on) => { if (on !== safe) onSafeMode(); }} />}
            </SettingsRow>
            <SettingsRow icon={<Layers size={16} />} title="安全模式范围" hint="从哪一档分级开始隐藏；还没分级的图照常显示，查找里的“R18”指范围内的各档">
              <Segmented<SafeModeScope> label="安全模式范围" value={view.safeModeScope ?? "questionable"}
                onChange={(scope) => void apply(setSafeModeScope(scope))} options={SAFE_MODE_SCOPES} />
            </SettingsRow>
            <SettingsRow icon={<MousePointerClick size={16} />} title="切换时保留选择" hint="选中的图和详情面板保持打开">
              <Switch label="切换时保留选择" checked={view.keepSelectionOnSafeMode ?? false} onCheckedChange={(on) => void apply(setKeepSelectionOnSafeMode(on))} />
            </SettingsRow>
            <SettingsRow icon={<ShieldCheck size={16} />} title="参考组与钉图" hint="原位模糊，点一下单张解开">
              <StatusPill tone={safe === false ? "plain" : "ok"}>{safe === false ? "未开启" : "已开启"}</StatusPill>
            </SettingsRow>
          </SettingsGroup>)}
          {page("update", <UpdateSection version={version ?? null} channel={view.updateChannel} onChannel={(next) => apply(setUpdateChannel(next))} />)}
          {page("diag", <>
            <RuntimeDetails />
            <SettingsGroup title="信息">
              <SettingsRow icon={<FileText size={16} />} title="诊断信息" hint="不含图片和文件名"
                below={<>
                  <p className="k-set-note">存成文件时附上最近 7 天的运行日志，打包成一个 zip，由你决定要不要发出去。</p>
                  {diagnostics.text !== null && <pre className="settings-diagnostics" aria-label="诊断信息">{diagnostics.text}</pre>}
                </>}>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.show}>查看</button>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.save}>存成文件…</button>
              </SettingsRow>
              <SettingsRow icon={<Activity size={16} />} title="运行日志" hint="只存本机，不上传"
                below={<p className="k-set-note">记下出错和截图、钉图、自动标签的时间点，帮开发者排查问题；不记文件名、路径、标签与图片。最多留 7 天、20 MB。
                  <button type="button" className="k-link" onClick={() => void clearRunLog().catch((e) => setError(String(e)))}>清除日志</button></p>}>
                <Switch label="运行日志" checked={view.runLog} onCheckedChange={(on) => void apply(setRunLog(on))} />
              </SettingsRow>
              <SettingsRow icon={<Monitor size={16} />} title="按 sRGB 显示" hint="排查偏色时打开"
                warn={view.forceSrgb !== view.forceSrgbInEffect && "从托盘退出并重启 Kinshoko 后生效。"}>
                <Switch label="按 sRGB 显示" checked={view.forceSrgb} onCheckedChange={(on) => void apply(setForceSrgb(on))} />
              </SettingsRow>
            </SettingsGroup>
          </>)}
        </div>
      </Tabs.Root>
    </section>
  );
}
