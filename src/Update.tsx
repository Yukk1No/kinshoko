import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UpdateChannel } from "./bindings/UpdateChannel";
import type { UpdateProgress } from "./bindings/UpdateProgress";
import type { UpdateStatus } from "./bindings/UpdateStatus";
import { CircleCheck, Download, FlaskConical, Info, RefreshCw } from "lucide-react";
import { Segmented } from "./ui/Segmented";
import { useToast, type ToastOptions } from "./ui/Toast";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";
import { checkUpdate, installUpdate, onUpdateChannelChanged, onUpdateProgress, updateStatus } from "./ipc";
import { i18n } from "./i18n";

/** 下载进度的文字，例如“正在下载 3.2／12.0 MB”。 */
function progressText(p: UpdateProgress | null): string {
  if (p === null) return i18n.t("update:progress.starting");
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  return p.total === null
    ? i18n.t("update:progress.downloaded", { downloaded: mb(p.downloaded) })
    : i18n.t("update:progress.downloadedOfTotal", { downloaded: mb(p.downloaded), total: mb(p.total) });
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
  const { t } = useTranslation("update");
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

  const pill = status.state === "upToDate" ? <StatusPill tone="ok" icon={<CircleCheck size={12} aria-hidden="true" />}>{t("upToDate")}</StatusPill>
    : status.state === "available" ? <StatusPill tone="accent">{t("available")}</StatusPill>
    : status.state === "failed" ? <StatusPill tone="warn">{t("checkFailed")}</StatusPill> : null;
  return (
    <SettingsGroup label={t("group")}>
      <SettingsRow icon={<Info size={16} />} title={t("currentVersion")} meta={version ?? "Kinshoko"}>{pill}</SettingsRow>
      {status.state === "manual" ? (
        <SettingsRow icon={<Download size={16} />} title={t("manual.title")} hint={t("manual.hint")}
          below={steps && <div className="k-set-note">
            <p>{status.message}</p>
            <p>{t("manual.steps")}</p>
          </div>}>
          <button type="button" className="k-btn is-sm" aria-expanded={steps} onClick={() => setSteps(!steps)}><span className="k-label">{steps ? t("manual.hideSteps") : t("manual.showSteps")}</span></button>
        </SettingsRow>
      ) : status.state === "disabled" ? (
        <SettingsRow icon={<Download size={16} />} title={t("automatic.title")} meta={t("automatic.disabled")} below={<p className="k-set-note">{status.message}</p>} />
      ) : (
        <>
          {channel !== undefined && onChannel && (
            <SettingsRow icon={<FlaskConical size={16} />} title={t("channel.title")} hint={channel === "beta" ? t("channel.betaHint") : t("channel.stableHint")}>
              <Segmented<UpdateChannel> label={t("channel.title")} value={channel} onChange={(next) => void changeChannel(next)} options={[
                { value: "stable", label: t("channel.stable") }, { value: "beta", label: t("channel.beta") },
              ]} />
            </SettingsRow>
          )}
          {status.state === "available" && (
            <SettingsRow icon={<Download size={16} />} title={t("install.title", { version: status.version })} meta={installing ? progressText(progress) : undefined} hint={t("install.hint")}
              below={status.notes && <p className="k-set-note update-notes">{status.notes}</p>}>
              {!installing && <button type="button" className="k-btn is-sm is-primary" onClick={() => void install()}><span className="k-label">{t("install.action")}</span></button>}
            </SettingsRow>
          )}
          <SettingsRow icon={<RefreshCw size={16} />} title={t("check.title")} hint={t("check.hint")}
            below={(status.state === "failed" || error !== null) && <>
              {status.state === "failed" && <p className="k-set-error" role="alert">{status.message}</p>}
              {error !== null && <p className="k-set-error" role="alert">{error}</p>}
            </>}>
            <button type="button" className="k-btn is-sm" disabled={checking || installing} onClick={() => void check()}><span className="k-label">{t("check.action")}</span></button>
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
    /** 通知现在的内容，按当前界面语言生成；换语言时重新生成（#354）。 */
    let content: (() => Omit<ToastOptions, "onClose">) | null = null;
    let progress: Promise<() => void> | null = null;
    const stopProgress = () => {
      void progress?.then((f) => f()).catch(() => {});
      progress = null;
    };
    const present = (id: string, next: () => Omit<ToastOptions, "onClose">) => {
      if (shown !== id) return;
      content = next;
      toast.update(id, next());
    };
    const installing = (version: string, p: UpdateProgress | null) => () =>
      ({ title: i18n.t("update:notice.installing", { version }), description: progressText(p), timeout: 0 });
    const install = (id: string, version: string) => {
      present(id, installing(version, null));
      progress = onUpdateProgress((p) => present(id, installing(version, p)));
      // 成功时 Kinshoko 退出，由安装程序装好后重新启动；只有失败会回到这里。
      installUpdate().catch((reason) => {
        stopProgress();
        present(id, () => ({
          title: i18n.t("update:notice.failed"), description: String(reason), tone: "error",
          action: { label: i18n.t("update:notice.retry"), onClick: () => install(id, version) },
        }));
      });
    };
    (async () => {
      let status = await updateStatus();
      if (status?.state === "unchecked") status = await checkUpdate();
      if (!alive || status?.state !== "available") return;
      const { version } = status;
      const available = () => ({
        title: i18n.t("update:notice.available", { version }), timeout: 0,
        action: { label: i18n.t("update:install.action"), onClick: () => install(id, version) },
      });
      const id: string = toast.show({ ...available(), onClose: () => { if (shown === id) shown = null; } });
      shown = id;
      content = available;
    })().catch(() => {});
    const relabel = () => { if (shown !== null && content) toast.update(shown, content()); };
    i18n.on("languageChanged", relabel);
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
      i18n.off("languageChanged", relabel);
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, [toast]);

  return null;
}
