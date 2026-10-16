import { useEffect, useState } from "react";
import type { UpdateProgress } from "./bindings/UpdateProgress";
import type { UpdateStatus } from "./bindings/UpdateStatus";
import { checkUpdate, installUpdate, onUpdateProgress, updateStatus } from "./ipc";

/** 下载进度的文字，例如“正在下载 3.2／12.0 MB”。 */
function progressText(p: UpdateProgress | null): string {
  if (p === null) return "正在下载更新…";
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  return p.total === null ? `正在下载 ${mb(p.downloaded)} MB` : `正在下载 ${mb(p.downloaded)}／${mb(p.total)} MB`;
}

/** 安装：下载期间显示进度；成功时 Kinshoko 退出，由安装程序装好后重新启动。 */
function useInstall() {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!installing) return;
    const unlisten = onUpdateProgress(setProgress);
    return () => {
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, [installing]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdate();
    } catch (reason) {
      setError(String(reason));
      setInstalling(false);
    }
  };
  return { installing, progress, error, install };
}

/**
 * 设置里的“更新”一节：当前状态、检查更新、有新版本时安装。
 * 没有配置更新公钥的构建（开发构建）只说明不检查更新。
 */
export function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const { installing, progress, error, install } = useInstall();

  useEffect(() => {
    let alive = true;
    updateStatus().then(
      (s) => {
        if (alive && s) setStatus(s);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  if (status === null) return null;

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await checkUpdate());
    } catch (reason) {
      setStatus({ state: "failed", message: String(reason) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <h2>更新</h2>
      {status.state === "disabled" ? (
        <p className="settings-hint">此构建未启用自动更新。</p>
      ) : (
        <>
          {status.state === "upToDate" && <p className="settings-hint">已是最新版本。</p>}
          {status.state === "failed" && (
            <p className="settings-error" role="alert">
              {status.message}
            </p>
          )}
          {status.state === "available" && (
            <>
              <p>可以更新到 {status.version}</p>
              {status.notes && <p className="settings-hint update-notes">{status.notes}</p>}
              {installing ? (
                <p className="settings-hint">{progressText(progress)}</p>
              ) : (
                <button type="button" onClick={() => void install()}>
                  安装并重启
                </button>
              )}
            </>
          )}
          {error !== null && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" disabled={checking || installing} onClick={() => void check()}>
            检查更新
          </button>
        </>
      )}
    </>
  );
}

/**
 * 主窗口顶部的更新提示。每次运行第一次显示主窗口时检查一次；有新版本时提示，
 * 画师可以安装或先不管（主窗口关掉前不再提示）。
 */
export function UpdateBanner() {
  const [available, setAvailable] = useState<{ version: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const { installing, progress, error, install } = useInstall();

  useEffect(() => {
    let alive = true;
    (async () => {
      let status = await updateStatus();
      if (status?.state === "unchecked") status = await checkUpdate();
      if (alive && status?.state === "available") setAvailable({ version: status.version });
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (available === null || dismissed) return null;
  return (
    <div className="update-banner" role="status">
      <span>Kinshoko {available.version} 可以更新。</span>
      {installing ? (
        <span>{progressText(progress)}</span>
      ) : (
        <>
          <button type="button" onClick={() => void install()}>
            安装并重启
          </button>
          <button type="button" onClick={() => setDismissed(true)}>
            以后再说
          </button>
        </>
      )}
      {error !== null && <span className="settings-error">{error}</span>}
    </div>
  );
}
