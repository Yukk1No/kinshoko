import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { RuntimeCapabilities } from "./bindings/RuntimeCapabilities";
import type { RuntimeStatus } from "./bindings/RuntimeStatus";
import { diagnosticsReport, exportDiagnostics, openRuntimeUpdate, runtimeStatus } from "./ipc";
import { probeRuntime } from "./runtime";

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
export function DiagnosticsReport({ onError }: { onError: (message: string) => void }) {
  const runtime = useContext(RuntimeContext);
  const [text, setText] = useState<string | null>(null);
  const facts = () => runtime ? runtime.check() : Promise.resolve(undefined);
  return <>
    <p className="settings-actions">
      <button type="button" onClick={() => void facts().then(diagnosticsReport).then(setText).catch((e) => onError(String(e)))}>显示诊断信息</button>
      <button type="button" onClick={() => void facts().then(exportDiagnostics).catch((e) => onError(String(e)))}>存成文件…</button>
    </p>
    {text !== null && <pre className="settings-diagnostics" aria-label="诊断信息">{text}</pre>}
  </>;
}

export function RuntimeNotice({ className = "", hidden = false }: { className?: string; hidden?: boolean }) {
  const runtime = useContext(RuntimeContext);
  const problems = runtime?.status?.assessment.problems ?? [];
  if (hidden || !problems.length) return null;
  return <RuntimeFailure problems={problems} className={className} />;
}

/** 实际生产路径也可直接报告失败，例如钉图窗口无法建立画布。 */
export function RuntimeFailure({ problems, className = "" }: { problems: string[]; className?: string }) {
  const runtime = useContext(RuntimeContext);
  const [error, setError] = useState<string | null>(null);
  return <aside className={`runtime-notice ${className}`} aria-label="运行时能力提示">
    <div role="alert"><strong>运行时能力检查未通过</strong><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>
    <p>更新 WebView2 后，从托盘退出并重启 Kinshoko。若问题继续出现，请保存本机诊断信息。</p>
    <p className="settings-actions">
      <button type="button" onClick={() => void openRuntimeUpdate().catch((e) => setError(String(e)))}>打开微软 WebView2 下载页</button>
      {runtime && <button type="button" disabled={runtime.checking} onClick={() => void runtime.check().catch((e) => setError(String(e)))}>重新检查运行时</button>}
    </p>
    <DiagnosticsReport onError={setError} />
    {error && <p role="alert">{error}</p>}
  </aside>;
}

/** 稳定的本机入口；成功只说明基础解码与绘制，色彩门槛保持独立。 */
export function RuntimeDetails() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) return null;
  const status = runtime.status;
  return <section className="runtime-details" aria-label="本机运行时">
    <h3>本机运行时</h3>
    <p>WebView2：{status?.webview2 ?? "未查询到"}</p>
    <p>{runtime.checking ? "正在检查基础图片解码与钉图绘制…" : !status ? "本窗口的能力检查未完成。" : status.assessment.problems.length ? "基础能力检查未通过。" : "基础图片解码与钉图绘制检查完成。"}</p>
    {status?.assessment.uses8bitFallback && <p>钉图使用 8 位画布降级。普通浏览可以继续。</p>}
    <p className="settings-hint">基础能力检查不代表色彩还原度通过。颜色异常时请保留诊断信息。</p>
    {status?.assessment.problems.length ? <RuntimeNotice /> : <button type="button" disabled={runtime.checking} onClick={() => void runtime.check().catch(() => {})}>重新检查运行时</button>}
    {runtime.error && <p role="alert">能力检查失败：{runtime.error}</p>}
  </section>;
}
