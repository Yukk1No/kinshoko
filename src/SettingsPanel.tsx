import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Activity, Archive, FileText, Keyboard, Monitor, Power, RefreshCw, Settings2, ShieldCheck, Tags } from "lucide-react";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { ShortcutBinding } from "./bindings/ShortcutBinding";
import {
  clearUsageLog,
  exportUsageLog,
  rebindShortcut,
  setAutostart,
  setForceSrgb,
  setShowApproxSource,
  setUsageLog,
  shellSettings,
} from "./ipc";
import { SharedPersonalApproxSettings } from "./search/SharedPersonalApproxSettings";
import { LegacyNameBanner } from "./library/LegacyNameMigrationPanel";
import { SharedTagGroupsSettings } from "./library/TagGroupsPane";
import { TagNamePanel } from "./library/TagNamePanel";
import { TagIdentityPanel } from "./library/TagIdentityPanel";
import { ApplicationSettingsBackup } from "./ApplicationSettingsBackup";
import { BackupSettings } from "./Backup";
import { ModelSettings } from "./ModelSettings";
import { UpdateSection } from "./Update";
import { RuntimeDetails, useDiagnosticsReport } from "./RuntimeSupport";
import { Segmented } from "./ui/Segmented";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";
import { Switch } from "./ui/Switch";
import { SealLock } from "./ui/SealLock";

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

export type SettingsTab = "general" | "keys" | "tags" | "backup" | "safety" | "update" | "diag";
const TABS: { value: SettingsTab; name: string; icon: ReactNode; lead: string }[] = [
  { value: "general", name: "通用", icon: <Settings2 size={15} aria-hidden="true" />, lead: "关掉窗口后，截图和钉图照常可用。" },
  { value: "keys", name: "快捷键", icon: <Keyboard size={15} aria-hidden="true" />, lead: "在任何软件里都能用。" },
  { value: "tags", name: "标签", icon: <Tags size={15} aria-hidden="true" />, lead: "改一次名字，所有图库都生效。" },
  { value: "backup", name: "备份", icon: <Archive size={15} aria-hidden="true" />, lead: "图片和设置分开存，恢复时互不影响。" },
  { value: "safety", name: "安全", icon: <ShieldCheck size={15} aria-hidden="true" />, lead: "成人图收进封印书，需要时再打开。" },
  { value: "update", name: "更新", icon: <RefreshCw size={15} aria-hidden="true" />, lead: "新版装在原位置，图库和设置都会保留。" },
  { value: "diag", name: "诊断", icon: <Activity size={15} aria-hidden="true" />, lead: "出问题时，把这里的信息发给开发者。" },
];

type TagView = "names" | "groups" | "approx" | "mapping";

type Props = {
  onRestored?: () => void;
  /** 兼容现有调用；个人规则不依赖当前资料库。 */
  library?: LibraryInfo | null;
  /** 应用壳设置保存后的结果，主窗口据此更新（例如相近标签来源标记）。 */
  onChange?: (view: ShellSettingsView) => void;
  /** 打开时所在的分页。 */
  initialTab?: SettingsTab;
  /** 导航底部的版本，例如“Kinshoko 0.1.2”。 */
  version?: string | null;
  /** 安全模式（主窗口持有）；没有时安全分页只说明行为。 */
  safe?: boolean;
  onSafeMode?: () => void;
  /** 打开“确认旧名称”向导（标签分页的提示条）。 */
  onOpenNameWizard?: () => void;
  /** 右上角关闭按钮（放在对话框里时）。 */
  closeButton?: ReactNode;
};

/**
 * 程序设置（#98）：竖排七个分页——通用、快捷键、标签、备份、安全、更新、诊断。
 * 每项一行：图标 · 名称 · 一句描述 · 右侧控件。行为与原来的各节相同，只是重新归位。
 */
export function SettingsPanel({ onChange, onRestored, initialTab = "general", version, safe, onSafeMode, onOpenNameWizard, closeButton }: Props) {
  const [settingsGeneration, setSettingsGeneration] = useState(0);
  const [view, setView] = useState<ShellSettingsView | null>(null);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [tagView, setTagView] = useState<TagView>("names");
  const diagnostics = useDiagnosticsReport(setError);

  useEffect(() => {
    let alive = true;
    shellSettings().then((value) => {
      if (alive) setView(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function apply(change: Promise<ShellSettingsView>) {
    try {
      const next = await change;
      setView(next);
      onChange?.(next);
      setError(null);
    } catch (reason) {
      setError(String(reason));
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

  if (view === null) return null;
  const restored = (next: ShellSettingsView) => { setView(next); onChange?.(next); setSettingsGeneration((generation) => generation + 1); onRestored?.(); };
  const page = (value: SettingsTab, children: ReactNode) => {
    const meta = TABS.find((entry) => entry.value === value)!;
    return <Tabs.Panel value={value} className="k-set-page">
      <h3 className="k-set-title">{meta.name}</h3>
      <p className="k-set-lead">{meta.lead}</p>
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
          {closeButton}
          {page("general", <>
            <SettingsGroup label="通用">
              <SettingsRow icon={<Power size={16} />} title="开机启动" desc="在托盘里待命">
                <Switch label="开机启动" checked={view.autostart} onCheckedChange={(on) => void apply(setAutostart(on))} />
              </SettingsRow>
            </SettingsGroup>
            <ModelSettings key={`model/${settingsGeneration}`} />
          </>)}
          {page("keys", <SettingsGroup label="快捷键">
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
            <SettingsRow label="安全模式" title="安全模式" desc="固定按键，在主窗口里用"><Keys accelerator="Ctrl+Shift+S" /></SettingsRow>
          </SettingsGroup>)}
          {page("tags", <>
            <Segmented<TagView> className="k-set-seg" label="标签设置" value={tagView} onChange={setTagView} options={[
              { value: "names", label: "显示名" }, { value: "groups", label: "分组" }, { value: "approx", label: "相近" }, { value: "mapping", label: "对应" },
            ]} />
            {tagView === "names" && <>
              <TagNamePanel key={`names/${settingsGeneration}`} />
              <LegacyNameBanner onOpen={onOpenNameWizard} />
            </>}
            {tagView === "groups" && <SharedTagGroupsSettings key={`groups/${settingsGeneration}`} onError={setError} />}
            {tagView === "approx" && <>
              <SettingsGroup label="相近标签">
                <SettingsRow icon={<Tags size={16} />} title="标出来源" desc="相近标签旁注明内置或个人">
                  <Switch label="标出来源" checked={view.showApproxSource} onCheckedChange={(on) => void apply(setShowApproxSource(on))} />
                </SettingsRow>
              </SettingsGroup>
              <SharedPersonalApproxSettings key={`approx/${settingsGeneration}`} onError={setError} />
            </>}
            {tagView === "mapping" && <TagIdentityPanel key={`identity/${settingsGeneration}`} />}
          </>)}
          {page("backup", <>
            <BackupSettings />
            <ApplicationSettingsBackup onRestored={restored} />
          </>)}
          {page("safety", <SettingsGroup label="安全">
            <SettingsRow icon={<SealLock size={10} />} title="安全模式" desc="隐藏成人图，钉图里模糊">
              <Keys accelerator="Ctrl+Shift+S" />
              {safe !== undefined && onSafeMode && <Switch label="安全模式" checked={safe} onCheckedChange={(on) => { if (on !== safe) onSafeMode(); }} />}
            </SettingsRow>
            <SettingsRow icon={<ShieldCheck size={16} />} title="参考组与钉图" desc="原位模糊，点一下单张解开">
              <StatusPill tone={safe === false ? "plain" : "ok"}>{safe === false ? "未开启" : "已开启"}</StatusPill>
            </SettingsRow>
          </SettingsGroup>)}
          {page("update", <UpdateSection version={version ?? null} />)}
          {page("diag", <>
            <RuntimeDetails />
            <SettingsGroup title="信息">
              <SettingsRow icon={<FileText size={16} />} title="诊断信息" desc="不含图片和文件名"
                below={diagnostics.text !== null && <pre className="settings-diagnostics" aria-label="诊断信息">{diagnostics.text}</pre>}>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.show}>查看</button>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.save}>保存…</button>
              </SettingsRow>
              <SettingsRow icon={<Activity size={16} />} title="使用记录" desc="只存本机，不上传"
                below={<p className="k-set-note">只记下做了哪类操作与数量，不记文件名、路径、标签与图片。
                  <button type="button" className="k-link" onClick={() => void exportUsageLog().catch((e) => setError(String(e)))}>导出记录…</button>
                  <button type="button" className="k-link" onClick={() => void clearUsageLog().catch((e) => setError(String(e)))}>清除记录</button></p>}>
                <Switch label="使用记录" checked={view.usageLog} onCheckedChange={(on) => void apply(setUsageLog(on))} />
              </SettingsRow>
              <SettingsRow icon={<Monitor size={16} />} title="按 sRGB 显示" desc="排查偏色时打开"
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
