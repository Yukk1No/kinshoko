
import { useTranslation } from "react-i18next";
import { Activity, FileText, Monitor, } from "lucide-react";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import { clearRunLog, errorText, } from "../ipc";
import { type ShellSettingsIntent } from "../shell/useShellSettings";
import { RuntimeDetails, useDiagnosticsReport } from "../RuntimeSupport";
import { SettingsGroup, SettingsRow, } from "../ui/SettingsList";
import { Switch } from "../ui/Switch";

// 设置 › 诊断分页，原样从 SettingsPanel.tsx 移出。

type Props = {
  view: ShellSettingsView;
  diagnostics: ReturnType<typeof useDiagnosticsReport>;
  setError: (message: string | null) => void;
  apply: (intent: ShellSettingsIntent) => Promise<boolean>;
};

export function DiagPage({ view, diagnostics, setError, apply }: Props) {
  const { t } = useTranslation("settings");
  return (
          <>
            <RuntimeDetails />
            <SettingsGroup label={t("diag.group")}>
              <SettingsRow icon={<FileText size={16} />} title={t("diag.report")} hint={t("diag.reportHint")}
                below={<>
                  {diagnostics.text !== null && <pre className="settings-diagnostics" aria-label={t("diag.report")}>{diagnostics.text}</pre>}
                </>}>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.show}><span className="k-label">{t("diag.show")}</span></button>
                <button type="button" className="k-btn is-sm" onClick={diagnostics.save}><span className="k-label">{t("diag.save")}</span></button>
              </SettingsRow>
              <SettingsRow icon={<Activity size={16} />} title={t("diag.runLog")} hint={t("diag.runLogHint")}
                below={<p className="k-set-note">
                  <button type="button" className="k-link" onClick={() => void clearRunLog().catch((e) => setError(errorText(e)))}>{t("diag.clearRunLog")}</button></p>}>
                <Switch label={t("diag.runLog")} checked={view.runLog} onCheckedChange={(on) => void apply({ kind: "runLog", on })} />
              </SettingsRow>
              <SettingsRow icon={<Monitor size={16} />} title={t("diag.srgb")} hint={t("diag.srgbHint")}
                warn={view.forceSrgb !== view.forceSrgbInEffect && t("diag.restartNeeded")}>
                <Switch label={t("diag.srgb")} checked={view.forceSrgb} onCheckedChange={(on) => void apply({ kind: "forceSrgb", on })} />
              </SettingsRow>
            </SettingsGroup>
          </>
  );
}
