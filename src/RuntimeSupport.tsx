import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { RuntimeCapabilities } from "./bindings/RuntimeCapabilities";
import type { RuntimeStatus } from "./bindings/RuntimeStatus";
import { diagnosticsReport, errorText, exportDiagnostics, openRuntimeUpdate, runtimeStatus } from "./ipc";
import { probeRuntime } from "./runtime";
import { CircleCheck, Monitor, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";

type RuntimeContextValue = {
  status: RuntimeStatus | null;
  error: string | null;
  checking: boolean;
  check: () => Promise<RuntimeCapabilities>;
};
const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const check = useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    try {
      const facts = await probeRuntime();
      const next = await runtimeStatus(facts);
      if (generation.current === request) { setStatus(next); setError(null); }
      return facts;
    } catch (reason) {
      if (generation.current === request) { setStatus(null); setError(String(reason)); }
      throw reason;
    } finally {
      if (generation.current === request) setChecking(false);
    }
  }, []);
  useEffect(() => { void check().catch(() => {}); return () => { generation.current += 1; }; }, [check]);
  return <RuntimeContext value={{ status, error, checking, check }}>{children}</RuntimeContext>;
}

/** 原有脱敏报告与保存对话框。每次由用户发起，测量本窗口，不保存能力日志、不上传。 */
export function useDiagnosticsReport(onError: (error: unknown) => void) {
  const runtime = useContext(RuntimeContext);
  const [text, setText] = useState<string | null>(null);
  const facts = () => runtime ? runtime.check() : Promise.resolve(undefined);
  return {
    text,
    show: () => void facts().then(diagnosticsReport).then(setText).catch((e) => onError(e)),
    save: () => void facts().then(exportDiagnostics).catch((e) => onError(e)),
  };
}

export function DiagnosticsReport({ onError }: { onError: (error: unknown) => void }) {
  const { t } = useTranslation("settings", { keyPrefix: "runtime" });
  const report = useDiagnosticsReport(onError);
  return <>
    <p className="settings-actions">
      <button type="button" className="k-btn is-sm" onClick={report.show}><span className="k-label">{t("showReport")}</span></button>
      <button type="button" className="k-btn is-sm" onClick={report.save}><span className="k-label">{t("save")}</span></button>
    </p>
    {report.text !== null && <pre className="settings-diagnostics" aria-label={t("report")}>{report.text}</pre>}
  </>;
}

export function RuntimeNotice({ className = "", hidden = false }: { className?: string; hidden?: boolean }) {
  const runtime = useContext(RuntimeContext);
  const problems = runtime?.status?.assessment.problems ?? [];
  if (hidden || !problems.length) return null;
  return <RuntimeFailure problems={problems} className={className} />;
}

/** 实际生产路径也可直接报告失败。 */
function RuntimeFailure({ problems, className = "" }: { problems: string[]; className?: string }) {
  const runtime = useContext(RuntimeContext);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation("settings", { keyPrefix: "runtime" });
  return <aside className={`runtime-notice ${className}`} aria-label={t("noticeLabel")}>
    <div role="alert"><strong>{t("failed")}</strong><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>
    <p>{t("advice")}</p>
    <p className="settings-actions">
      <button type="button" className="k-btn is-sm" onClick={() => void openRuntimeUpdate().catch((e) => setError(String(e)))}><span className="k-label">{t("download")}</span></button>
      {runtime && <button type="button" className="k-btn is-sm" disabled={runtime.checking} onClick={() => void runtime.check().catch((e) => setError(String(e)))}><span className="k-label">{t("recheck")}</span></button>}
    </p>
    <DiagnosticsReport onError={(e) => setError(errorText(e))} />
    {error && <p role="alert">{error}</p>}
  </aside>;
}

/** 稳定的本机入口（设置 › 诊断 › 运行环境）；成功只说明基础解码，色彩门槛保持独立。 */
export function RuntimeDetails() {
  const runtime = useContext(RuntimeContext);
  const { t } = useTranslation("settings", { keyPrefix: "runtime" });
  if (!runtime) return null;
  const status = runtime.status;
  const failed = !!status?.assessment.problems.length;
  const state = runtime.checking ? <StatusPill>{t("checking")}</StatusPill>
    : !status ? <StatusPill tone="warn">{t("incomplete")}</StatusPill>
    : failed ? <StatusPill tone="warn">{t("notPassed")}</StatusPill>
    : <StatusPill tone="ok" icon={<CircleCheck size={12} aria-hidden="true" />}>{t("ok")}</StatusPill>;
  return <section className="runtime-details" aria-label={t("label")}>
    <SettingsGroup label={t("label")}>
      <SettingsRow icon={<Monitor size={16} />} title={t("display")} meta={t("webview2", { version: status?.webview2 ?? t("unknownVersion") })}>{state}</SettingsRow>
      <SettingsRow icon={<RefreshCw size={16} />} title={t("recheck")} hint={t("recheckHint")}>
        <button type="button" className="k-btn is-sm" disabled={runtime.checking} onClick={() => void runtime.check().catch(() => {})}><span className="k-label">{t("check")}</span></button>
      </SettingsRow>
    </SettingsGroup>
    {failed && <RuntimeNotice className="is-inline" />}
    {runtime.error && <p className="k-set-error" role="alert">{t("checkFailed", { error: runtime.error })}</p>}
  </section>;
}
