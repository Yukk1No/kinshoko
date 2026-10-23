import { useEffect, useState } from "react";
import type { UpdateChannel } from "./bindings/UpdateChannel";
import type { UpdateProgress } from "./bindings/UpdateProgress";
import type { UpdateStatus } from "./bindings/UpdateStatus";
import { CircleCheck, Download, FlaskConical, Info, RefreshCw } from "lucide-react";
import { Segmented } from "./ui/Segmented";
import { useToast } from "./ui/Toast";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";
import { checkUpdate, installUpdate, onUpdateChannelChanged, onUpdateProgress, updateStatus } from "./ipc";

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
 * 设置 › 更新：当前版本与状态、更新通道、检查更新、有新版本时安装。
 * 手动更新构建说明安装包步骤；自动更新构建缺少条件时说明原因，这两种情况不显示更新通道。
 * 换通道（#204）由设置页保存；保存成功后按新通道重新检查。
 */
export function UpdateSection({ version = null, channel, onChannel }: {
  version?: string | null;
  channel?: UpdateChannel;
  /** 保存更新通道；返回是否成功（失败原因由设置页显示）。 */
  onChannel?: (channel: UpdateChannel) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [steps, setSteps] = useState(false);
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

  const changeChannel = async (next: UpdateChannel) => {
    if (onChannel && await onChannel(next)) await check();
  };

  const pill = status.state === "upToDate" ? <StatusPill tone="ok"><CircleCheck size={12} aria-hidden="true" />已是最新</StatusPill>
    : status.state === "available" ? <StatusPill tone="accent">有新版本</StatusPill>
    : status.state === "failed" ? <StatusPill tone="warn">检查失败</StatusPill> : null;
  return (
    <SettingsGroup label="更新">
      <SettingsRow icon={<Info size={16} />} title="当前版本" meta={version ?? "Kinshoko"}>{pill}</SettingsRow>
      {status.state === "manual" ? (
        <SettingsRow icon={<Download size={16} />} title="手动更新" hint="从托盘退出，再运行新安装包"
          below={steps && <div className="k-set-note">
            <p>{status.message}</p>
            <p>从托盘退出 Kinshoko 后，运行开发者提供的新版安装包，安装到原位置。装好后重新打开，继续使用已有图库、设置、参考组和钉图。</p>
          </div>}>
          <button type="button" className="k-btn is-sm" aria-expanded={steps} onClick={() => setSteps(!steps)}><span className="k-label">{steps ? "收起步骤" : "查看步骤"}</span></button>
        </SettingsRow>
      ) : status.state === "disabled" ? (
        <SettingsRow icon={<Download size={16} />} title="自动更新" meta="这个版本未开启" below={<p className="k-set-note">{status.message}</p>} />
      ) : (
        <>
          {channel !== undefined && onChannel && (
            <SettingsRow icon={<FlaskConical size={16} />} title="更新通道" hint={channel === "beta" ? "收测试版、候选版和正式版" : "只收正式版"}>
              <Segmented<UpdateChannel> label="更新通道" value={channel} onChange={(next) => void changeChannel(next)} options={[
                { value: "stable", label: "正式版" }, { value: "beta", label: "测试版" },
              ]} />
            </SettingsRow>
          )}
          {status.state === "available" && (
            <SettingsRow icon={<Download size={16} />} title={`可以更新到 ${status.version}`} meta={installing ? progressText(progress) : undefined} hint="装好后自动重启"
              below={status.notes && <p className="k-set-note update-notes">{status.notes}</p>}>
              {!installing && <button type="button" className="k-btn is-sm is-primary" onClick={() => void install()}><span className="k-label">安装并重启</span></button>}
            </SettingsRow>
          )}
          <SettingsRow icon={<RefreshCw size={16} />} title="检查更新" hint="从发布页查找新版本"
            below={(status.state === "failed" || error !== null) && <>
              {status.state === "failed" && <p className="k-set-error" role="alert">{status.message}</p>}
              {error !== null && <p className="k-set-error" role="alert">{error}</p>}
            </>}>
            <button type="button" className="k-btn is-sm" disabled={checking || installing} onClick={() => void check()}><span className="k-label">检查更新</span></button>
          </SettingsRow>
        </>
      )}
    </SettingsGroup>
  );
}

/**
 * 主窗口右下角的更新通知。每次运行第一次显示主窗口时检查一次；有新版本时通知，
 * 画师可以安装或关掉（本次运行不再通知）。安装时通知里显示下载进度，失败时可以重试。
 * 换了更新通道后收起。
 */
export function UpdateNotice() {
  const toast = useToast();

  useEffect(() => {
    if (!toast) return;
    let alive = true;
    /** 正在显示的更新通知；画师关掉后为 null。 */
    let shown: string | null = null;
    let progress: Promise<() => void> | null = null;
    const stopProgress = () => {
      void progress?.then((f) => f()).catch(() => {});
      progress = null;
    };
    const installing = (version: string, p: UpdateProgress | null) =>
      ({ title: `正在更新到 ${version}`, description: progressText(p), timeout: 0 });
    const install = (id: string, version: string) => {
      toast.update(id, installing(version, null));
      progress = onUpdateProgress((p) => { if (shown === id) toast.update(id, installing(version, p)); });
      // 成功时 Kinshoko 退出，由安装程序装好后重新启动；只有失败会回到这里。
      installUpdate().catch((reason) => {
        stopProgress();
        if (shown === id) toast.update(id, {
          title: "更新失败", description: String(reason), tone: "error",
          action: { label: "重试", onClick: () => install(id, version) },
        });
      });
    };
    (async () => {
      let status = await updateStatus();
      if (status?.state === "unchecked") status = await checkUpdate();
      if (!alive || status?.state !== "available") return;
      const { version } = status;
      const id: string = toast.show({
        title: `Kinshoko ${version} 可以更新`, timeout: 0,
        action: { label: "安装并重启", onClick: () => install(id, version) },
        onClose: () => { if (shown === id) shown = null; },
      });
      shown = id;
    })().catch(() => {});
    const close = () => {
      const id = shown;
      shown = null;
      if (id !== null) toast.close(id);
    };
    // 换了更新通道：旧通道查到的版本已作废（安装会失败），收起通知。
    const unlisten = onUpdateChannelChanged(() => {
      alive = false;
      close();
    });
    return () => {
      alive = false;
      close();
      stopProgress();
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, [toast]);

  return null;
}
