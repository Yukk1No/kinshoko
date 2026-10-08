import { useEffect, useState, type KeyboardEvent } from "react";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { ShortcutBinding } from "./bindings/ShortcutBinding";
import {
  clearUsageLog,
  diagnosticsReport,
  exportDiagnostics,
  exportUsageLog,
  rebindShortcut,
  setAutostart,
  setForceSrgb,
  setShowApproxSource,
  setUsageLog,
  shellSettings,
} from "./ipc";
import { SharedPersonalApproxSettings } from "./search/SharedPersonalApproxSettings";
import { LegacyNameMigrationPanel } from "./library/LegacyNameMigrationPanel";
import { SharedTagGroupsSettings } from "./library/TagGroupsPane";
import { TagNamePanel } from "./library/TagNamePanel";
import { TagIdentityPanel } from "./library/TagIdentityPanel";
import { UpdateSection } from "./Update";

const ACTION_LABELS: Record<ShortcutAction, string> = {
  capture: "截图",
  pinClipboard: "钉剪贴板",
  hideAllPins: "收起全部钉图",
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

type Props = {
  nameMigrationRequest?: number;
  /** 兼容现有调用；个人规则不依赖当前资料库。 */
  library?: LibraryInfo | null;
  /** 应用壳设置保存后的结果，主窗口据此更新（例如相近标签来源标记）。 */
  onChange?: (view: ShellSettingsView) => void;
};

/**
 * 设置：“常驻与快捷键”一节（开机自启开关，每个全局快捷键的更换与清除）；
 * “近似查找”一节（来源标记开关，全局个人近似对应表及旧规则冲突）；
 * “诊断”一节（强制 sRGB、诊断信息、使用日志）；“更新”一节。
 */
export function SettingsPanel({ onChange, nameMigrationRequest = 0 }: Props) {
  const [view, setView] = useState<ShellSettingsView | null>(null);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="settings" aria-label="设置">
      <h2>常驻与快捷键</h2>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={view.autostart}
          onChange={(e) => void apply(setAutostart(e.currentTarget.checked))}
        />
        开机时启动 Kinshoko
      </label>
      <p className="settings-hint">关闭主窗口后 Kinshoko 留在托盘，截图、钉图与快捷键照常可用。</p>
      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <table className="settings-shortcuts">
        <tbody>
          {view.shortcuts.map((binding: ShortcutBinding) => {
            const label = ACTION_LABELS[binding.action];
            return (
              <tr key={binding.action} aria-label={label}>
                <th scope="row">{label}</th>
                <td>
                  {recording === binding.action ? (
                    <input
                      aria-label="按下新的快捷键"
                      placeholder="按下新的快捷键，Esc 取消"
                      autoFocus
                      readOnly
                      onKeyDown={(e) => onRecordKey(binding.action, e)}
                      onBlur={() => setRecording(null)}
                    />
                  ) : (
                    <kbd>{binding.accelerator ?? "未设置"}</kbd>
                  )}
                  {binding.problem !== null && (
                    <span className="settings-problem">未注册：{binding.problem}</span>
                  )}
                </td>
                <td>
                  <button type="button" onClick={() => setRecording(binding.action)}>
                    更换
                  </button>
                  <button
                    type="button"
                    disabled={binding.accelerator === null}
                    onClick={() => void apply(rebindShortcut(binding.action, null))}
                  >
                    清除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TagIdentityPanel />
      <TagNamePanel />
      <LegacyNameMigrationPanel openRequest={nameMigrationRequest} />
      <SharedTagGroupsSettings onError={setError} />
      <h2>近似查找</h2>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={view.showApproxSource}
          onChange={(e) => void apply(setShowApproxSource(e.currentTarget.checked))}
        />
        显示相近标签来源（内置／个人）
      </label>
      <SharedPersonalApproxSettings onError={setError} />
      <h2>诊断</h2>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={view.forceSrgb}
          onChange={(e) => void apply(setForceSrgb(e.currentTarget.checked))}
        />
        强制 sRGB（诊断用）
      </label>
      <p className="settings-hint">
        让 WebView2 把显示器当作 sRGB、不按显示器配置文件校色。只在排查颜色问题时打开。
        {view.forceSrgb !== view.forceSrgbInEffect && <strong> 从托盘退出并重启 Kinshoko 后生效。</strong>}
      </p>
      <DiagnosticsReport onError={setError} />
      <label className="settings-row">
        <input
          type="checkbox"
          checked={view.usageLog}
          onChange={(e) => void apply(setUsageLog(e.currentTarget.checked))}
        />
        记录使用日志（只存在本机）
      </label>
      <p className="settings-hint">
        只记下做了哪类操作与数量（例如导入了几项、查找用了几个条件），不记文件名、路径、标签与图片，也不会自动上传。
      </p>
      <p className="settings-actions">
        <button type="button" onClick={() => void exportUsageLog().catch((e) => setError(String(e)))}>
          导出使用日志…
        </button>
        <button type="button" onClick={() => void clearUsageLog().catch((e) => setError(String(e)))}>
          清除使用日志
        </button>
      </p>
      <UpdateSection />
    </section>
  );
}

/** 诊断信息：按需生成，显示全文，可以存成文件贴到问题反馈里。 */
function DiagnosticsReport({ onError }: { onError: (message: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const show = () => diagnosticsReport().then(setText, (e) => onError(String(e)));
  return (
    <>
      <p className="settings-actions">
        <button type="button" onClick={() => void show()}>
          显示诊断信息
        </button>
        <button type="button" onClick={() => void exportDiagnostics().catch((e) => onError(String(e)))}>
          存成文件…
        </button>
      </p>
      {text !== null && (
        <pre className="settings-diagnostics" aria-label="诊断信息">
          {text}
        </pre>
      )}
    </>
  );
}
