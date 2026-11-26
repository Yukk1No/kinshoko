import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UpdateChannel } from "./bindings/UpdateChannel";
import type { UpdateProgress } from "./bindings/UpdateProgress";
import type { UpdateStatus } from "./bindings/UpdateStatus";
import { CircleCheck, Download, FlaskConical, Info, RefreshCw } from "lucide-react";
import { Segmented } from "./ui/Segmented";
import { NOTICE_ORDER, useToast, type ToastOptions } from "./ui/Toast";
import { SettingsGroup, SettingsRow, StatusPill } from "./ui/SettingsList";
import { checkUpdate, installUpdate, onUpdateChannelChanged, onUpdateProgress, updateStatus } from "./ipc";
import { CommandFailure, describeCommandError, errorText } from "./ipc/commandError";
import { createBackendMirror } from "./ipc/backendMirror";
import { useBackendMirror } from "./ipc/useBackendMirror";
import { i18n } from "./i18n";
import { formatBytes } from "./i18n/format";
import { logFailure } from "./runLog";

const UPDATE_STATUS_KEY = "update-status";
const UPDATE_PROGRESS_KEY = "update-progress";

/**
 * 更新状态的后端镜像（#761）：设置页与主窗口通知共享上次检查结果。
 * 换通道事件不携带状态；后端已先把旧结果作废，镜像失效后重读。
 */
const updateStatusMirror = createBackendMirror<typeof UPDATE_STATUS_KEY, UpdateStatus>({
  read: () => updateStatus(),
  listen: (invalidate) => onUpdateChannelChanged(() => invalidate(UPDATE_STATUS_KEY)),
});

function acceptUpdateStatus(status: UpdateStatus) {
  updateStatusMirror.accept(UPDATE_STATUS_KEY, status);
}

function useUpdateStatus() {
  return useBackendMirror(updateStatusMirror, UPDATE_STATUS_KEY);
}

type UpdateProgressValue = { current: UpdateProgress | null };

/** 下载进度镜像：只有正在安装时订阅；事件携带这一刻的完整进度。 */
const updateProgressMirror = createBackendMirror<typeof UPDATE_PROGRESS_KEY, UpdateProgressValue>({
  read: async () => ({ current: null }),
  listen: (_invalidate, accept) => onUpdateProgress((progress) => accept(UPDATE_PROGRESS_KEY, { current: progress })),
});

function useUpdateProgress(enabled: boolean) {
  return useBackendMirror(updateProgressMirror, UPDATE_PROGRESS_KEY, enabled).value?.current ?? null;
}

/** 下载进度的文字，例如“正在下载 3.2 MB／12 MB”。 */
function progressText(p: UpdateProgress | null): string {
  if (p === null) return i18n.t("update:progress.starting");
  return p.total === null
    ? i18n.t("update:progress.downloaded", { downloaded: formatBytes(p.downloaded) })
    : i18n.t("update:progress.downloadedOfTotal", {
        downloaded: formatBytes(p.downloaded),
        total: formatBytes(p.total),
      });
}

const installingNotice = (version: string, progress: UpdateProgress | null) => () => ({
  title: i18n.t("update:notice.installing", { version }),
  description: progressText(progress),
  timeout: 0,
});

/** 安装：下载期间显示进度；成功时 Kinshoko 退出，由安装程序装好后重新启动。 */
function useInstall() {
  const [installing, setInstalling] = useState(false);
  const progress = useUpdateProgress(installing);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdate();
    } catch (reason) {
      setError(errorText(reason));
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
export function UpdateSection({
  version = null,
  channel,
  onChannel,
}: {
  version?: string | null;
  channel?: UpdateChannel;
  /** 保存更新通道；返回是否成功（失败原因由设置页显示）。 */
  onChannel?: (channel: UpdateChannel) => Promise<boolean>;
}) {
  const { t } = useTranslation("update");
  const { value: status } = useUpdateStatus();
  const [checking, setChecking] = useState(false);
  const [steps, setSteps] = useState(false);
  const { installing, progress, error, install } = useInstall();

  if (status === null) return null;

  const check = async () => {
    setChecking(true);
    try {
      acceptUpdateStatus(await checkUpdate());
    } catch (reason) {
      acceptUpdateStatus({
        state: "failed",
        message: reason instanceof CommandFailure ? reason.error : { code: "system", detail: errorText(reason) },
      });
    } finally {
      setChecking(false);
    }
  };

  const changeChannel = async (next: UpdateChannel) => {
    if (onChannel && (await onChannel(next))) await check();
  };

  const pill =
    status.state === "upToDate" ? (
      <StatusPill tone="ok" icon={<CircleCheck size={12} aria-hidden="true" />}>
        {t("upToDate")}
      </StatusPill>
    ) : status.state === "available" ? (
      <StatusPill tone="accent">{t("available")}</StatusPill>
    ) : status.state === "failed" ? (
      <StatusPill tone="warn">{t("checkFailed")}</StatusPill>
    ) : null;
  return (
    <SettingsGroup label={t("group")}>
      <SettingsRow icon={<Info size={16} />} title={t("currentVersion")} meta={version ?? "Kinshoko"}>
        {pill}
      </SettingsRow>
      {status.state === "manual" ? (
        <SettingsRow
          icon={<Download size={16} />}
          title={t("manual.title")}
          hint={t("manual.hint")}
          below={
            steps && (
              <div className="k-description is-spaced">
                <p>{describeCommandError(status.message)}</p>
                <p>{t("manual.steps")}</p>
              </div>
            )
          }
        >
          <button type="button" className="k-btn is-sm" aria-expanded={steps} onClick={() => setSteps(!steps)}>
            <span className="k-label">{steps ? t("manual.hideSteps") : t("manual.showSteps")}</span>
          </button>
        </SettingsRow>
      ) : status.state === "disabled" ? (
        <SettingsRow
          icon={<Download size={16} />}
          title={t("automatic.title")}
          meta={t("automatic.disabled")}
          below={<p className="k-description is-spaced">{describeCommandError(status.message)}</p>}
        />
      ) : (
        <>
          {channel !== undefined && onChannel && (
            <SettingsRow
              icon={<FlaskConical size={16} />}
              title={t("channel.title")}
              hint={channel === "beta" ? t("channel.betaHint") : t("channel.stableHint")}
            >
              <Segmented<UpdateChannel>
                label={t("channel.title")}
                value={channel}
                onChange={(next) => void changeChannel(next)}
                options={[
                  { value: "stable", label: t("channel.stable") },
                  { value: "beta", label: t("channel.beta") },
                ]}
              />
            </SettingsRow>
          )}
          {status.state === "available" && (
            <SettingsRow
              icon={<Download size={16} />}
              title={t("install.title", { version: status.version })}
              meta={installing ? progressText(progress) : undefined}
              below={status.notes && <p className="k-description is-spaced update-notes">{status.notes}</p>}
            >
              {!installing && (
                <button type="button" className="k-btn is-sm is-primary" onClick={() => void install()}>
                  <span className="k-label">{t("install.action")}</span>
                </button>
              )}
            </SettingsRow>
          )}
          <SettingsRow
            icon={<RefreshCw size={16} />}
            title={t("check.title")}
            below={
              (status.state === "failed" || error !== null) && (
                <>
                  {status.state === "failed" && (
                    <p className="k-error-text is-boxed" role="alert">
                      {describeCommandError(status.message)}
                    </p>
                  )}
                  {error !== null && (
                    <p className="k-error-text is-boxed" role="alert">
                      {error}
                    </p>
                  )}
                </>
              )
            }
          >
            <button
              type="button"
              className="k-btn is-sm"
              disabled={checking || installing}
              onClick={() => void check()}
            >
              <span className="k-label">{t("check.action")}</span>
            </button>
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
  const { value: status, error: statusError, refreshing } = useUpdateStatus();
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const progress = useUpdateProgress(installingVersion !== null);
  /** 正在显示的更新通知；画师关掉或换通道收起后为 null。 */
  const shown = useRef<string | null>(null);
  /** 通知现在的内容，按当前界面语言生成；换语言时重新生成（#354）。 */
  const content = useRef<(() => Omit<ToastOptions, "onClose">) | null>(null);
  /** 本次运行已经通知过的版本；关掉后不再为同一个版本打扰。 */
  const announced = useRef<string | null>(null);
  const automaticCheck = useRef(false);

  const present = useCallback(
    (id: string, next: () => Omit<ToastOptions, "onClose">) => {
      if (shown.current !== id) return;
      content.current = next;
      toast.update(id, next());
    },
    [toast],
  );
  const close = useCallback(() => {
    const id = shown.current;
    shown.current = null;
    content.current = null;
    if (id !== null) toast.close(id);
  }, [toast]);

  const installRef = useRef<(id: string, version: string) => void>(() => {});
  const install = useCallback(
    (id: string, version: string) => {
      setInstallingVersion(version);
      present(id, installingNotice(version, null));
      // 成功时 Kinshoko 退出，由安装程序装好后重新启动；只有失败会回到这里。
      void installUpdate().catch((reason) => {
        setInstallingVersion(null);
        present(id, () => ({
          title: i18n.t("update:notice.failed"),
          description: errorText(reason),
          tone: "error",
          action: {
            label: i18n.t("update:notice.retry"),
            onClick: () => installRef.current(id, version),
            keepOpen: true,
          },
        }));
      });
    },
    [present],
  );
  installRef.current = install;

  // 自动检查不是画师点的，失败不打扰；设置 › 更新里点检查会显示原因。记一条供排查。
  useEffect(() => {
    if (statusError) logFailure("automatic update check", statusError);
  }, [statusError]);

  // 第一次读到“还没检查过”时自动检查一次；检查完成后的完整状态写回共享镜像。
  useEffect(() => {
    if (automaticCheck.current || status?.state !== "unchecked") return;
    automaticCheck.current = true;
    checkUpdate().then(acceptUpdateStatus, (e) => logFailure("automatic update check", e));
  }, [status]);

  // 这个镜像只有换通道事件会让它失效：正在重读就表示旧通道查到的版本已作废，先收起通知。
  useEffect(() => {
    if (!refreshing) return;
    setInstallingVersion(null);
    close();
  }, [refreshing, close]);

  // 进度事件经共享镜像到达；每一次都是这一刻的完整进度，直接就地更新通知。
  useEffect(() => {
    if (installingVersion === null || shown.current === null) return;
    present(shown.current, installingNotice(installingVersion, progress));
  }, [installingVersion, progress, present]);

  useEffect(() => {
    if (refreshing || status?.state !== "available" || shown.current !== null || announced.current === status.version)
      return;
    announced.current = status.version;
    const { version } = status;
    const available = () => ({
      title: i18n.t("update:notice.available", { version }),
      timeout: 0,
      action: { label: i18n.t("update:install.action"), onClick: () => install(id, version), keepOpen: true },
    });
    const id: string = toast.show({
      ...available(),
      queue: NOTICE_ORDER.update,
      onClose: () => {
        if (shown.current === id) {
          shown.current = null;
          content.current = null;
          setInstallingVersion(null);
        }
      },
    });
    shown.current = id;
    content.current = available;
  }, [status, refreshing, toast, install]);

  useEffect(() => {
    const relabel = () => {
      if (shown.current !== null && content.current) toast.update(shown.current, content.current());
    };
    i18n.on("languageChanged", relabel);
    return () => {
      i18n.off("languageChanged", relabel);
    };
  }, [toast]);

  useEffect(() => close, [close]);

  return null;
}
