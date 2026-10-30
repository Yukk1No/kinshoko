import { useState } from "react";
import type { ApplicationSettingsRestored } from "./bindings/ApplicationSettingsRestored";
import type { ApplicationSettingsPreview } from "./bindings/ApplicationSettingsPreview";
import { describeCommandError, exportApplicationSettings, migrateViewerBackground, pickApplicationSettings, previewApplicationSettings } from "./ipc";
import { Settings2 } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./ui/SettingsList";
import { legacyViewerBackground, rememberViewerBackground } from "./viewer/background";

/** 设置 › 备份 › 偏好设置（原“程序设置备份”）：单独保存名称偏好、应用级词表、标签分组、相近规则和程序配置；替换前先读取并确认范围。 */
export function ApplicationSettingsBackup({ restore: replace }: {
  /** 整份替换偏好设置，经设置页的提交模型排在之前的写入之后（#321）。 */
  restore: (path: string, fingerprint: string) => Promise<ApplicationSettingsRestored>;
}) {
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
    setPath(file); setPreview(null); setMessage("偏好设置已导出。");
  });
  const inspectFile = async (file: string) => { setPreview(await previewApplicationSettings(file)); };
  // 恢复：选好文件就读取，确认替换范围后才真正恢复。
  const pick = () => run(async () => {
    const file = await pickApplicationSettings(false);
    if (!file) return;
    setPath(file); setPreview(null);
    await inspectFile(file);
  });
  const inspect = () => run(() => inspectFile(path.trim()));
  const restore = () => run(async () => {
    if (!preview) return;
    const result = await replace(path.trim(),preview.fingerprint);
    rememberViewerBackground(result.settings.viewerBackground ?? "mid");
    setPreview(null);
    setMessage(result.settings.forceSrgb !== result.settings.forceSrgbInEffect
      ? "偏好设置已恢复。按 sRGB 显示从托盘退出并重启后生效。" : "偏好设置已恢复。名称、查找习惯与快捷键已按备份生效。");
    if (result.problems.length) setError(result.problems.map(describeCommandError).join("；"));
  });
  return <section className="application-settings-backup" aria-label="偏好设置备份">
    <SettingsGroup label="偏好设置">
      <SettingsRow icon={<Settings2 size={16} />} title="标签名称、分组与快捷键" hint="存成一个文件，换电脑也能用"
        below={<>
          <div className="k-set-inline">
            <input className="k-input" aria-label="偏好设置备份文件" value={path} disabled={busy} placeholder="或输入 .kinshoko-settings 文件位置"
              onChange={(e)=>{setPath(e.target.value);setPreview(null);setMessage(null);setError(null);}} />
            {path.trim() && !preview && <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void inspect()}><span className="k-label">读取</span></button>}
          </div>
          {busy && <p role="status">正在读取或保存偏好设置…</p>}
          {preview && <div className="k-confirm" role="group" aria-label="确认替换偏好设置">
            <p>会替换：名称偏好、应用级词表、标签分组、相近规则、快捷键、安全模式、模型选择、标签外观、诊断与查看器背景。</p>
            <p>备份里没有的名称偏好和相近规则会删除。图库里的原图、备注、标签、分级与目录不变。</p>
            <p>恢复后的安全模式：<strong>{preview.safeMode ? "开启" : "关闭（成人参考图可以显示）"}</strong>。按 sRGB 显示：{preview.forceSrgb ? "开启" : "关闭"}，重启后生效。</p>
            <div className="k-confirm-actions">
              <button type="button" className="k-btn is-sm is-primary" disabled={busy} onClick={()=>void restore()}><span className="k-label">替换偏好设置</span></button>
              <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>setPreview(null)}><span className="k-label">取消</span></button>
            </div>
          </div>}
          {message && <p role="status">{message}</p>}
          {error && <p className="k-set-error" role="alert">{error}</p>}
        </>}>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void pick()}><span className="k-label">恢复…</span></button>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void exportFile()}><span className="k-label">导出</span></button>
      </SettingsRow>
    </SettingsGroup>
  </section>;
}
