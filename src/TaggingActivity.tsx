import { useEffect, useRef, useState } from "react";
import { CircleAlert, Download, MonitorPause, Pause } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Device } from "./bindings/Device";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { taggingDownload } from "./ipc";
import { useToast } from "./ui/Toast";
import { i18n } from "./i18n";
import { formatNumber } from "./i18n/format";
import { useTaggingStatus } from "./useTaggingStatus";
import { describeCommandError, describeCommandErrors } from "./ipc/commandError";

const deviceName = (device: Device) => i18n.t(`tagging:device.${device}`);
const mb = (bytes: number) => formatNumber(Math.round(bytes / 1_000_000), { useGrouping: false });
const percent = (part: number, total: number) => (total > 0 ? Math.floor((part / total) * 100) : 0);

/** 图标上的状态文字；不显示图标的状态为 null。 */
function activityLabel(status: TaggingStatus): string | null {
  switch (status.state) {
    case "downloading":
      return i18n.t("tagging:activity.downloading", { percent: percent(status.downloaded, status.total) });
    case "starting":
      return i18n.t("tagging:activity.starting");
    case "preparing":
      return i18n.t("tagging:activity.preparing");
    case "running":
      return i18n.t("tagging:activity.running", { count: status.tagged, device: deviceName(status.device) });
    case "paused":
      return i18n.t("tagging:activity.paused");
    case "yieldedToFullScreen":
      return i18n.t("tagging:activity.yieldedToFullScreen");
    // 停住、要画师处理的状态也留一个静止的图标：关掉通知后仍有地方找回（点开是设置 › 自动标签）。
    case "needsDownload":
      return i18n.t("tagging:activity.needsDownload");
    case "failed":
      return i18n.t("tagging:activity.failed");
    case "noDevice":
      return i18n.t("tagging:activity.noDevice");
    default:
      return null;
  }
}

/** 打标状态变化时的右下角通知（#144）。 */
function useTaggingNotices(status: TaggingStatus | null) {
  const toast = useToast();
  /** 正在显示的“需要下载”通知。 */
  const download = useRef<string | null>(null);
  /** 画师关掉过“需要下载”通知：本次启动内不再弹。 */
  const declined = useRef(false);
  /** 本次启动内报过的“不可用”原因。 */
  const unavailable = useRef(new Set<string>());
  /** 最近报过的出错原因；重试会经过加载、打标或下载再失败，到打完或暂停才算过去。 */
  const failure = useRef<string | null>(null);
  /** 这一轮开始时本次运行已打的张数（这一轮第一条 Running 的 `tagged`）。 */
  const roundStart = useRef<number | null>(null);
  /** 上一次看到的状态。 */
  const previous = useRef<TaggingStatus | null>(null);

  useEffect(() => {
    if (!status) return;
    const before = previous.current;
    previous.current = status;
    // 下载中暂停或取消（#213）也不算下载完成。
    if (before?.state === "downloading" && !["downloading", "failed", "needsDownload", "paused"].includes(status.state)) {
      toast.show({ title: i18n.t("tagging:notice.downloaded"), tone: "success" });
    }
    // 后端出错后定时重试并反复广播：一直是同一个原因时只报一次。
    const failed = status.state === "failed" ? describeCommandError(status.reason) : null;
    if (failed !== null && failure.current !== failed) {
      failure.current = failed;
      toast.error(i18n.t("tagging:notice.failed", { reason: failed }), { description: i18n.t("tagging:notice.retrying") });
    }
    if (status.state === "idle" || status.state === "paused") failure.current = null;
    if (status.state === "running") roundStart.current ??= status.tagged;
    if (status.state === "idle") {
      // Running 在打每张之前推送，最后一张只在 Idle 的累计张数里。
      const taggedThisRound = before?.state === "running" && roundStart.current !== null ? status.tagged - roundStart.current : 0;
      roundStart.current = null;
      if (taggedThisRound > 0) toast.show({ title: i18n.t("tagging:notice.tagged", { count: taggedThisRound }), tone: "success" });
    }
    const missing = status.state === "noDevice" ? describeCommandErrors(status.reasons) : null;
    if (missing !== null && !unavailable.current.has(missing)) {
      unavailable.current.add(missing);
      toast.show({ title: i18n.t("tagging:notice.unavailable", { reason: missing }), timeout: 0 });
    }
    // 代码收起的通知先清掉记录，onClose 才不把它当成画师关掉的。
    const closeDownload = () => {
      const id = download.current;
      download.current = null;
      if (id !== null) toast.close(id);
    };
    if (status.state !== "needsDownload") return closeDownload();
    // 画师取消了下载（#213）：和关掉通知一样，本次启动内不再弹。
    if (status.cancelled) declined.current = true;
    if (download.current !== null || declined.current) return;
    const start = () => {
      closeDownload();
      void taggingDownload().then(
        () => toast.show({ title: i18n.t("tagging:notice.downloading") }),
        (e) => toast.error(i18n.t("tagging:notice.downloadFailed", { error: String(e) })),
      );
    };
    const id = toast.show({
      title: i18n.t("tagging:notice.needsDownload", { size: mb(status.size) }), timeout: 0,
      action: { label: status.downloaded > 0 ? i18n.t("tagging:notice.resume") : i18n.t("tagging:notice.download"), onClick: start },
      onClose: () => {
        if (download.current !== id) return;
        download.current = null;
        declined.current = true;
      },
    });
    download.current = id;
  }, [toast, status]);
}

/** 外圈进度（0 到 1）：下载看字节，打标看这一轮处理过的张数；加载、校验时没有进度，为 null。 */
function liveProgress(status: TaggingStatus): number | null {
  if (status.state === "downloading") return status.total > 0 ? status.downloaded / status.total : 0;
  if (status.state === "running") return status.done / Math.max(1, status.done + status.remaining);
  return null;
}

/** 暂停时外圈停在暂停前的位置：记住最近一次有进度的状态的进度，停下（不显示图标）时清掉。 */
function useRingProgress(status: TaggingStatus | null) {
  const [kept, setKept] = useState<number | null>(null);
  const live = status && liveProgress(status);
  const holds = status?.state === "paused" || status?.state === "yieldedToFullScreen";
  const next = live ?? (holds ? kept : null);
  if (kept !== next) setKept(next);
  return next;
}

/** 闪光星（lucide Sparkles）：进行中两颗小星交替明暗，大星不动（#372）。 */
function TwinkleSparkles({ size }: { size: number }) {
  return (
    <svg className="k-tagging-sparkles" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path className="k-twinkle-a" d="M20 3v4M22 5h-4" />
      <path className="k-twinkle-b" d="M4 17v2M5 18H3" />
    </svg>
  );
}

/** 进度环：底圈加一段弧；没有进度时只有底圈，进行中时底圈换成强调色慢慢明暗。 */
function Ring({ className, size, radius, progress }: { className: string; size: number; radius: number; progress: number | null }) {
  const c = size / 2;
  return (
    <svg className={className} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="k-tagging-track" cx={c} cy={c} r={radius} />
      {progress !== null && <circle className="k-tagging-arc" cx={c} cy={c} r={radius} pathLength={100}
        strokeDasharray={`${Math.round(progress * 1000) / 10} 100`} />}
    </svg>
  );
}

/**
 * 自动标签在主窗口的位置（#144）：图片墙右下角、缩放滑块左边的小圆钮。外圈是进度环（#372）：下载看字节，
 * 打标看这一轮的张数，加载时整圈慢慢明暗；圆钮里的星星两颗小星交替闪烁。暂停时环停在原处变灰，图标换成暂停；
 * 其他状态不显示。悬停看进度，点击打开设置 › 自动标签。状态是所有资料库合计（#414），不跟哪个库走。
 */
export function TaggingActivity({ onOpenSettings, collapsed = false }: {
  onOpenSettings: () => void;
  /** 多选悬浮栏出现、右下角收成一个圆形按钮时（#180）：图标换成按钮右上角的小圆点，状态仍看得到。 */
  collapsed?: boolean;
}) {
  // 状态文字按界面语言取：换语言时重绘。
  useTranslation();
  const status = useTaggingStatus();
  useTaggingNotices(status);
  const progress = useRingProgress(status);
  const text = status && activityLabel(status);
  if (!status || !text) return null;
  const stopped = status.state === "needsDownload" || status.state === "failed" || status.state === "noDevice";
  const activity = stopped ? "stopped" : status.state === "paused" || status.state === "yieldedToFullScreen" ? "paused" : "busy";
  const pending = (!stopped && progress === null) || undefined;
  if (collapsed) {
    // 小圆点只表示进行中的进度；停住的状态等收起结束后再回到原处的图标。
    if (stopped) return null;
    return (
      <span className="k-tagging-dot" data-activity={activity} data-pending={pending} role="img" title={text} aria-label={i18n.t("tagging:label", { text })}>
        <Ring className="k-tagging-mini" size={12} radius={4.5} progress={progress} />
      </span>
    );
  }
  return (
    <button type="button" className="k-tagging-activity" data-activity={activity} data-pending={pending}
      title={text} aria-label={i18n.t("tagging:openSettings", { text })} onClick={onOpenSettings}>
      <Ring className="k-tagging-ring" size={40} radius={18} progress={progress} />
      {status.state === "needsDownload" ? <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        : status.state === "failed" || status.state === "noDevice" ? <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        : status.state === "paused" ? <Pause size={16} strokeWidth={1.75} aria-hidden="true" />
        : status.state === "yieldedToFullScreen" ? <MonitorPause size={16} strokeWidth={1.75} aria-hidden="true" />
        : <TwinkleSparkles size={16} />}
    </button>
  );
}
