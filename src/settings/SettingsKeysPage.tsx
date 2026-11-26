import { type KeyboardEvent, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import type { ShortcutAction } from "../bindings/ShortcutAction";
import type { ShortcutBinding } from "../bindings/ShortcutBinding";
import { errorText, hotkeyFailureText } from "../ipc";
import { type ShellSettingsIntent } from "../shell/useShellSettings";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { Keys } from "../ui/Keys";
import { keymapEntryText } from "../keymap/KeymapRegistry";
import { keymapRegistry } from "../keymap/registry";

// 设置 › 快捷键分页，原样从 SettingsPanel.tsx 移出。

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
  view: ShellSettingsView;
  recording: ShortcutAction | null;
  setRecording: (action: ShortcutAction | null) => void;
  apply: (intent: ShellSettingsIntent) => Promise<boolean>;
  pauseShortcuts: (paused: boolean) => Promise<void>;
  onError: (message: string) => void;
};

export function KeysPage({ view, recording, setRecording, apply, pauseShortcuts, onError }: Props) {
  const { t } = useTranslation("settings");
  // 注册表键跨多个命名空间；这个 `t` 的类型只认识 settings 命名空间，这里按运行时的完整键调用。
  const keymapText = t as unknown as (key: string) => string;
  const isRecordingAny = recording !== null;
  // 全局快捷键在系统层先于 WebView 收到按键；录制期间暂停，按到已绑定的键才能录下或提示冲突。
  useEffect(() => {
    if (!isRecordingAny) return;
    const report = (e: unknown) => onError(errorText(e));
    pauseShortcuts(true).catch(report);
    return () => {
      pauseShortcuts(false).catch(report);
    };
  }, [isRecordingAny, pauseShortcuts, onError]);
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

  return (
    <>
      <SettingsGroup label={t("keys.group")}>
        {view.shortcuts.map((binding: ShortcutBinding) => {
          const label = t(`keys.action.${binding.action}`);
          const isRecording = recording === binding.action;
          return (
            <SettingsRow
              key={binding.action}
              label={label}
              title={label}
              className={isRecording ? "is-recording" : ""}
              warn={binding.problem !== null && t("keys.notRegistered", { reason: hotkeyFailureText(binding.problem) })}
            >
              {isRecording ? (
                <>
                  <input
                    className="k-key-recorder"
                    aria-label={t("keys.record")}
                    placeholder={t("keys.recordPlaceholder")}
                    autoFocus
                    readOnly
                    onKeyDown={(e) => onRecordKey(binding.action, e)}
                    onBlur={() => setRecording(null)}
                  />
                  <button
                    type="button"
                    className="k-btn is-sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setRecording(null)}
                  >
                    <span className="k-label">{t("keys.cancel")}</span>
                  </button>
                </>
              ) : (
                <>
                  {binding.accelerator === null ? (
                    <span className="k-set-muted">{t("keys.unset")}</span>
                  ) : (
                    <Keys accelerator={binding.accelerator} />
                  )}
                  {binding.accelerator !== null && (
                    <button
                      type="button"
                      className="k-btn is-sm is-quiet"
                      onClick={() => void apply({ kind: "shortcut", action: binding.action, accelerator: null })}
                    >
                      <span className="k-label">{t("keys.clear")}</span>
                    </button>
                  )}
                  <button type="button" className="k-btn is-sm" onClick={() => setRecording(binding.action)}>
                    <span className="k-label">{binding.accelerator === null ? t("keys.set") : t("keys.change")}</span>
                  </button>
                </>
              )}
            </SettingsRow>
          );
        })}
        {keymapRegistry.settingsEntries("main").map((entry) => {
          const label = keymapText(entry.labelKey);
          return (
            <SettingsRow
              key={entry.action}
              label={label}
              title={label}
              hint={entry.settings?.hintKey ? keymapText(entry.settings.hintKey) : undefined}
            >
              <Keys accelerator={keymapEntryText(entry, keymapText)} />
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      {/* 查看器的操作提示（#179，原在查看器的信息浮层里）。 */}
      <SettingsGroup label={t("keys.viewerGroup")}>
        {keymapRegistry.settingsEntries("viewer").map((entry) => {
          const label = keymapText(entry.labelKey);
          return (
            <SettingsRow key={entry.action} label={label} title={label}>
              <Keys accelerator={keymapEntryText(entry, keymapText)} />
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </>
  );
}
