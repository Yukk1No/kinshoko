import { useState } from "react";
import type { ApplicationSettingsRestored } from "../bindings/ApplicationSettingsRestored";
import type { ApplicationSettingsPreview } from "../bindings/ApplicationSettingsPreview";
import { describeCommandError, exportApplicationSettings, pickApplicationSettings, previewApplicationSettings } from "../ipc";
import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/Toast";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { rememberViewerBackground } from "../viewer/background";
import { errorText } from "../ipc/commandError";

/** 设置 › 备份 › 偏好设置（原“程序设置备份”）：单独保存名称偏好、应用级词表、标签分组、相近规则和程序配置；替换前先读取并确认范围。 */
export function ApplicationSettingsBackup({ restore: replace }: {
  /** 整份替换偏好设置，经设置页的提交模型排在之前的写入之后（#321）。 */
  restore: (path: string, fingerprint: string) => Promise<ApplicationSettingsRestored>;
}) {
  const { t } = useTranslation("backup", { keyPrefix: "settings" });
  const [path,setPath] = useState("");
  const [preview,setPreview] = useState<ApplicationSettingsPreview | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const toast = useToast();
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const exportFile = () => run(async () => {
    const file = path.trim() || await pickApplicationSettings(true);
    if (!file) return;
    await exportApplicationSettings(file);
    setPath(file); setPreview(null); toast.show({ title: t("exported"), tone: "success" });
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
    toast.show({ title: result.settings.forceSrgb !== result.settings.forceSrgbInEffect
      ? t("restoredSrgb") : t("restored"), tone: "success" });
    if (result.problems.length) setError(result.problems.map(describeCommandError).join(t("problemSeparator")));
  });
  return <section className="application-settings-backup" aria-label={t("label")}>
    <SettingsGroup label={t("group")}>
      <SettingsRow icon={<Settings2 size={16} />} title={t("title")} hint={t("hint")}
        below={<>
          <div className="k-set-inline">
            <input className="k-input" aria-label={t("file")} value={path} disabled={busy} placeholder={t("filePlaceholder")}
              onChange={(e)=>{setPath(e.target.value);setPreview(null);setError(null);}} />
            {path.trim() && !preview && <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void inspect()}><span className="k-label">{t("read")}</span></button>}
          </div>
          {busy && <p role="status">{t("busy")}</p>}
          {preview && <div className="k-confirm" role="group" aria-label={t("confirm")}>
            <p>{t("replaces")}</p>
            <p>{t("deletes")}</p>
            <p>{t("safeModeAfter")}<strong>{preview.safeMode ? t("safeOn") : t("safeOff")}</strong>{t("srgbAfter", { state: preview.forceSrgb ? t("on") : t("off") })}</p>
            <div className="k-confirm-actions">
              <button type="button" className="k-btn is-sm is-primary" disabled={busy} onClick={()=>void restore()}><span className="k-label">{t("replace")}</span></button>
              <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>setPreview(null)}><span className="k-label">{t("cancel")}</span></button>
            </div>
          </div>}
          {error && <p className="k-set-error" role="alert">{error}</p>}
        </>}>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void pick()}><span className="k-label">{t("restore")}</span></button>
        <button type="button" className="k-btn is-sm" disabled={busy} onClick={()=>void exportFile()}><span className="k-label">{t("export")}</span></button>
      </SettingsRow>
    </SettingsGroup>
  </section>;
}
