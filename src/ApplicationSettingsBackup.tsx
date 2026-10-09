import { useState } from "react";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { ApplicationSettingsPreview } from "./bindings/ApplicationSettingsPreview";
import { exportApplicationSettings, migrateViewerBackground, pickApplicationSettings, previewApplicationSettings, restoreApplicationSettings } from "./ipc";
import { legacyViewerBackground, rememberViewerBackground } from "./viewer/background";

/** Uses the accepted prototype SettingsDialog fieldset/actions pattern with real package actions. */
export function ApplicationSettingsBackup({ onRestored }: { onRestored: (settings: ShellSettingsView) => void }) {
  const [path,setPath] = useState("");
  const [preview,setPreview] = useState<ApplicationSettingsPreview | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const [message,setMessage] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const exportFile = () => run(async () => {
    const file = path.trim() || await pickApplicationSettings(true);
    if (!file) return;
    await migrateViewerBackground(legacyViewerBackground());
    await exportApplicationSettings(file);
    setPath(file); setPreview(null); setMessage("程序设置备份完成。");
  });
  const pick = () => run(async () => {
    const file = await pickApplicationSettings(false);
    if (file) { setPath(file); setPreview(null); }
  });
  const inspect = () => run(async () => { setPreview(await previewApplicationSettings(path.trim())); });
  const restore = () => run(async () => {
    if (!preview) return;
    const result = await restoreApplicationSettings(path.trim(),preview.fingerprint);
    rememberViewerBackground(result.settings.viewerBackground ?? "mid");
    onRestored(result.settings); setPreview(null);
    setMessage(result.settings.forceSrgb !== result.settings.forceSrgbInEffect
      ? "程序设置恢复完成。强制 sRGB 从托盘退出并重启后生效。" : "程序设置恢复完成。名称、查找习惯与快捷键已按备份生效。");
    if (result.problems.length) setError(result.problems.join("；"));
  });
  return <fieldset aria-label="程序设置备份">
    <legend>程序设置备份</legend>
    <p className="settings-hint">单独保存名称偏好、应用级词表、标签分组、个人近似规则和程序配置。资料库备份位于下方。</p>
    <label className="settings-backup-path">备份文件<input aria-label="程序设置备份文件" value={path} disabled={busy} placeholder="选择 .kinshoko-settings 文件" onChange={(e)=>{setPath(e.target.value);setPreview(null);setMessage(null);setError(null);}} /></label>
    <div className="settings-actions">
      <button type="button" disabled={busy} onClick={()=>void exportFile()}>备份当前程序设置</button>
      <button type="button" disabled={busy} onClick={()=>void pick()}>选择程序设置备份…</button>
      <button type="button" disabled={busy || !path.trim()} onClick={()=>void inspect()}>读取程序设置备份</button>
    </div>
    {busy && <p role="status">正在读取或保存程序设置…</p>}
    {preview && <div role="group" aria-label="确认替换程序设置">
      <p>默认替换当前配置：名称偏好、应用级词表、标签分组、个人近似规则、快捷键、安全模式、模型选择、诊断与查看器背景。</p>
      <p>缺席的名称偏好和个人规则会删除。资料库原图、逐图备注、标签、分级与目录保持。</p>
      <p>恢复后的安全模式：<strong>{preview.safeMode ? "开启" : "关闭（成人参考图可以显示）"}</strong>。强制 sRGB：{preview.forceSrgb ? "开启" : "关闭"}，重启后生效。</p>
      <button type="button" disabled={busy} onClick={()=>void restore()}>替换程序设置</button>
      <button type="button" disabled={busy} onClick={()=>setPreview(null)}>取消替换</button>
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
