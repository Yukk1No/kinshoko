import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { CircleAlert, Download, EyeOff, Images, MonitorPause, Pause, Play, RotateCw, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FailedTagging } from "./bindings/FailedTagging";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { taggingDownload, taggingPause, taggingResume, taggingRetryFailed } from "./ipc";
import { MenuItem, MenuSeparator, PointerMenu } from "./ui/Menu";
import { useTaggingProgress, useUnfinishedTagging, type TaggingProgress } from "./useTaggingProgress";
import { useToast } from "./ui/Toast";
import { i18n } from "./i18n";
import { formatBytes, percentOf } from "./i18n/format";
import { useTaggingStatus } from "./useTaggingStatus";
import { describeCommandError, describeCommandErrors } from "./ipc/commandError";

/** 预计用时的说法：不到一分钟、几分钟或几小时。 */
function etaText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return i18n.t("tagging:activity.etaUnderMinute");
  if (minutes < 60) return i18n.t("tagging:activity.etaMinutes", { count: minutes });
  return i18n.t("tagging:activity.etaHours", { count: Math.round(minutes / 60) });
}

/** 没有完成的图分哪几类：“2 张无法读取，1 张出错”，没有的一类不写。 */
function failureKinds(failed: FailedTagging): string {
  return [
    failed.unreadable > 0 && i18n.t("tagging:activity.unreadable", { count: failed.unreadable }),
    failed.crashed > 0 && i18n.t("tagging:activity.crashed", { count: failed.crashed }),
  ].filter(Boolean).join(i18n.t("tagging:activity.separator"));
}

/** 图标上的状态：悬停标签的两段（第二段颜色浅一些，可以没有）；不显示图标的状态为 null。 */
function activityLabel(status: TaggingStatus, progress: TaggingProgress, unfinished: boolean): [string, string | null] | null {
  const eta = progress.eta === null ? null : etaText(progress.eta);
  switch (status.state) {
    case "downloading":
      return [i18n.t("tagging:activity.downloading", { percent: percentOf(status.downloaded, status.total) }), null];
    case "starting":
      return [i18n.t("tagging:activity.starting"), null];
    case "preparing":
      return [i18n.t("tagging:activity.preparing"), null];
    case "running":
      return [i18n.t("tagging:activity.remaining", { count: status.remaining }), eta];
    case "paused":
      return progress.remaining === null ? [i18n.t("tagging:activity.paused"), null]
        : [i18n.t("tagging:activity.pausedRemaining", { count: progress.remaining }), eta];
    case "yieldedToFullScreen":
      return [i18n.t("tagging:activity.yieldedToFullScreen"), null];
    // 停住、要画师处理的状态也留一个静止的图标：关掉通知后仍有地方找回（右键进设置 › 自动标签）。
    case "needsDownload":
      return [i18n.t("tagging:activity.needsDownload"), null];
    case "failed":
      return [i18n.t("tagging:activity.failed"), null];
    case "noDevice":
      return [i18n.t("tagging:activity.noDevice"), null];
    // 有图没有完成（#475）：常驻到画师忽略。
    case "idle":
      return unfinished ? [i18n.t("tagging:activity.unfinished", { count: status.failed.unreadable + status.failed.crashed }), failureKinds(status.failed)] : null;
  }
}

/** 点击图标做什么：打标中暂停、暂停时继续、有图没有完成时重试；停住的状态没有动作，打开设置。 */
type Act = "pause" | "resume" | "retry" | null;

function actOf(status: TaggingStatus): Act {
  switch (status.state) {
    case "downloading":
    case "starting":
    case "preparing":
    case "running":
    case "yieldedToFullScreen":
      return "pause";
    case "paused":
      return "resume";
    case "idle":
      return "retry";
    default:
      return null;
  }
}

const ACT: Record<Exclude<Act, null>, { run: () => Promise<void>; icon: ReactNode }> = {
  pause: { run: taggingPause, icon: <Pause size={16} strokeWidth={1.75} aria-hidden="true" /> },
  resume: { run: taggingResume, icon: <Play size={16} strokeWidth={1.75} aria-hidden="true" /> },
  retry: { run: taggingRetryFailed, icon: <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" /> },
};

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
      title: i18n.t("tagging:notice.needsDownload", { size: formatBytes(status.size) }), timeout: 0,
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

/** 当前状态的图标。 */
function stateIcon(status: TaggingStatus): ReactNode {
  switch (status.state) {
    case "needsDownload":
      return <Download size={16} strokeWidth={1.75} aria-hidden="true" />;
    case "failed":
    case "noDevice":
    case "idle":
      return <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />;
    case "paused":
      return <Pause size={16} strokeWidth={1.75} aria-hidden="true" />;
    case "yieldedToFullScreen":
      return <MonitorPause size={16} strokeWidth={1.75} aria-hidden="true" />;
    default:
      return <TwinkleSparkles size={16} />;
  }
}

/**
 * 自动标签在主窗口的位置（#144）：图片墙右下角、缩放滑块左边的小圆钮。外圈是进度环（#372）：下载看字节，
 * 打标看这一轮的张数，加载时整圈慢慢明暗；圆钮里的星星两颗小星交替闪烁。暂停时环停在原处变灰，图标换成暂停。
 * 有图没有完成时（#475）显示提示图标，直到画师忽略。状态是所有资料库合计（#414），不跟哪个库走。
 *
 * 点击直接操作（#475）：打标中暂停、暂停时继续、有图没有完成时重试；悬停时图标变成点击后的动作，
 * 上方的墨紫标签写剩余张数与预计用时，或没有完成的张数与原因。右键是查看这些图、忽略与自动标签设置；
 * 停住的状态（需要下载、出错、不可用）点击也打开设置。
 */
export function TaggingActivity({ onOpenSettings, onShowUnfinished, collapsed = false }: {
  onOpenSettings: () => void;
  /** 回到图片墙，筛出没有完成自动标签的图（#475）。 */
  onShowUnfinished?: () => void;
  /** 多选悬浮栏出现、右下角收成一个圆形按钮时（#180）：图标换成按钮右上角的小圆点，状态仍看得到。 */
  collapsed?: boolean;
}) {
  // 状态文字按界面语言取：换语言时重绘。
  useTranslation();
  const status = useTaggingStatus();
  useTaggingNotices(status);
  const ring = useRingProgress(status);
  const progress = useTaggingProgress(status);
  const unfinished = useUnfinishedTagging(status?.state === "idle" ? status.failed : null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const label = status && activityLabel(status, progress, unfinished.shown);
  if (!status || !label) return null;
  const text = label[1] ? i18n.t("tagging:activity.parts", { first: label[0], second: label[1] }) : label[0];
  const stopped = status.state === "needsDownload" || status.state === "failed" || status.state === "noDevice" || status.state === "idle";
  const activity = status.state === "idle" ? "unfinished" : stopped ? "stopped"
    : status.state === "paused" || status.state === "yieldedToFullScreen" ? "paused" : "busy";
  const pending = (!stopped && ring === null) || undefined;
  if (collapsed) {
    // 小圆点只表示进行中的进度；停住的状态等收起结束后再回到原处的图标。
    if (stopped) return null;
    return (
      <span className="k-tagging-dot" data-activity={activity} data-pending={pending} role="img" title={text} aria-label={i18n.t("tagging:label", { text })}>
        <Ring className="k-tagging-mini" size={12} radius={4.5} progress={ring} />
      </span>
    );
  }
  const act = actOf(status);
  const next = act && ACT[act];
  const click = () => {
    if (next) void next.run().catch(() => {});
    else onOpenSettings();
  };
  return <>
    <Tooltip.Root>
      <Tooltip.Trigger delay={200} closeOnClick={false} render={
        <button type="button" className="k-tagging-activity" data-activity={activity} data-pending={pending}
          aria-label={act ? i18n.t(`tagging:act.${act}`, { text }) : i18n.t("tagging:openSettings", { text })} onClick={click}
          onContextMenu={(e) => {
            e.preventDefault();
            // 键盘打开的右键菜单没有指针位置：贴着图标左上角。
            const box = e.currentTarget.getBoundingClientRect();
            setMenu(e.clientX === 0 && e.clientY === 0 ? { x: box.left, y: box.top } : { x: e.clientX, y: e.clientY });
          }} />}>
        <Ring className="k-tagging-ring" size={40} radius={18} progress={ring} />
        <span className="k-tagging-glyph" data-morph={next ? true : undefined}>
          <span className="k-tagging-now">{stateIcon(status)}</span>
          {next && <span className="k-tagging-next">{next.icon}</span>}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner className="k-positioner" side="top" sideOffset={10}>
          <Tooltip.Popup className="k-tip">{label[0]}{label[1] && <span className="k-tip-note">{label[1]}</span>}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
    {menu && <PointerMenu point={menu} label={i18n.t("tagging:menu.label")} onClose={() => setMenu(null)}>
      {unfinished.shown && <>
        <MenuItem icon={<Images size={16} aria-hidden="true" />} onClick={() => onShowUnfinished?.()}>{i18n.t("tagging:menu.show")}</MenuItem>
        <MenuItem icon={<EyeOff size={16} aria-hidden="true" />} onClick={unfinished.ignore}>{i18n.t("tagging:menu.ignore")}</MenuItem>
        <MenuSeparator />
      </>}
      <MenuItem icon={<Settings size={16} aria-hidden="true" />} onClick={onOpenSettings}>{i18n.t("tagging:menu.settings")}</MenuItem>
    </PointerMenu>}
  </>;
}
