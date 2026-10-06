import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { PersonalApproxEntry } from "./bindings/PersonalApproxEntry";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { ShortcutBinding } from "./bindings/ShortcutBinding";
import {
  personalApprox,
  rebindShortcut,
  removeTagApprox,
  setAutostart,
  setShowApproxSource,
  shellSettings,
} from "./ipc";
import { TagMarks, tagName, UI_LANG } from "./search/SearchBox";

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
  /** 当前资料库；有时列出它的个人近似对应表。 */
  library?: LibraryInfo | null;
  /** 应用壳设置保存后的结果，主窗口据此更新（例如相近标签来源标记）。 */
  onChange?: (view: ShellSettingsView) => void;
};

/**
 * 设置：“常驻与快捷键”一节（开机自启开关，每个全局快捷键的更换与清除）；
 * “近似查找”一节（来源标记开关，当前资料库的个人近似对应表条目及删除）。
 */
export function SettingsPanel({ library = null, onChange }: Props) {
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
      <h2>近似查找</h2>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={view.showApproxSource}
          onChange={(e) => void apply(setShowApproxSource(e.currentTarget.checked))}
        />
        显示相近标签来源（内置／个人）
      </label>
      {library && <PersonalApproxList key={library.id} onError={setError} />}
    </section>
  );
}

/** 当前资料库的个人近似对应表：每条两个标签与“相近／不相近”，可以删除。 */
function PersonalApproxList({ onError }: { onError: (message: string) => void }) {
  const [entries, setEntries] = useState<PersonalApproxEntry[] | null>(null);

  const load = useCallback(
    () =>
      personalApprox(UI_LANG).then(
        (list) => setEntries(list),
        (e) => onError(String(e)),
      ),
    [onError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (entry: PersonalApproxEntry) => {
    try {
      await removeTagApprox(entry.a.id, entry.b.id);
      await load();
    } catch (e) {
      onError(String(e));
    }
  };

  if (entries === null) return null;
  if (entries.length === 0) {
    return (
      <p className="settings-hint">
        个人近似对应表还是空的。查找时关掉相近标签选“以后都不展开”，或用“＋”加相近标签，会记在这里。
      </p>
    );
  }
  return (
    <table className="settings-approx" aria-label="个人近似对应表">
      <tbody>
        {entries.map((entry) => (
          <tr key={`${entry.a.id}/${entry.b.id}`}>
            <td>
              {tagName(entry.a)}
              <TagMarks tag={entry.a} />～{tagName(entry.b)}
              <TagMarks tag={entry.b} />
            </td>
            <td>{entry.relation === "similar" ? "相近" : "不相近"}</td>
            <td>
              <button type="button" onClick={() => void remove(entry)}>
                删除
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
