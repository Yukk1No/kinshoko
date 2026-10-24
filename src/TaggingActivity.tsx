import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { Device } from "./bindings/Device";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { taggingDownload } from "./ipc";
import { useToast } from "./ui/Toast";
import { useTaggingStatus } from "./useTaggingStatus";

const DEVICE_NAME: Record<Device, string> = { directMl: "显卡", cpu: "CPU" };
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const percent = (part: number, total: number) => (total > 0 ? Math.floor((part / total) * 100) : 0);

/** 图标上的状态文字；不显示图标的状态为 null。 */
function activityLabel(status: TaggingStatus): string | null {
  switch (status.state) {
    case "downloading":
      return `正在下载自动标签模型 ${percent(status.downloaded, status.total)}%`;
    case "starting":
      return "正在加载自动标签模型";
    case "preparing":
      return "正在校验自动标签模型";
    case "running":
      return `正在自动标签，已标 ${status.tagged} 张（${DEVICE_NAME[status.device]}）`;
    case "paused":
      return "已暂停";
    case "yieldedToFullScreen":
      return "因全屏程序暂停";
    default:
      return null;
  }
}

/** 打标状态变化时的右下角通知（#144）。 */
function useTaggingNotices(libraryId: string | null, status: TaggingStatus | null) {
  const toast = useToast();
  /** 正在显示的“需要下载”通知。 */
  const download = useRef<string | null>(null);
  /** 画师关掉过“需要下载”通知的资料库：本次启动内不再弹。 */
  const declined = useRef(new Set<string>());
  /** 本次启动内报过的“不可用”原因。 */
  const unavailable = useRef(new Set<string>());
  /** 最近报过的出错原因；重试会经过加载、打标或下载再失败，到打完或暂停才算过去。 */
  const failure = useRef<string | null>(null);
  /** 这一轮开始时本次运行已打的张数（这一轮第一条 Running 的 `tagged`）。 */
  const roundStart = useRef<number | null>(null);
  /** 上一次看到的状态与它所属的资料库：换库后不拿旧库的状态比较。 */
  const previous = useRef<{ libraryId: string; status: TaggingStatus } | null>(null);

  useEffect(() => {
    if (!toast || libraryId === null || !status) return;
    const before = previous.current?.libraryId === libraryId ? previous.current.status : null;
    if (before === null) {
      roundStart.current = null;
      failure.current = null;
    }
    previous.current = { libraryId, status };
    // 下载中暂停或取消（#213）也不算下载完成。
    if (before?.state === "downloading" && !["downloading", "failed", "needsDownload", "paused"].includes(status.state)) {
      toast.show({ title: "已下载自动标签模型", tone: "success" });
    }
    // 后端出错后定时重试并反复广播：一直是同一个原因时只报一次。
    if (status.state === "failed" && failure.current !== status.reason) {
      failure.current = status.reason;
      toast.error(`自动标签出错：${status.reason}`, { description: "稍后会自动重试" });
    }
    if (status.state === "idle" || status.state === "paused") failure.current = null;
    if (status.state === "running") roundStart.current ??= status.tagged;
    if (status.state === "idle") {
      // Running 在打每张之前推送，最后一张只在 Idle 的累计张数里。
      const taggedThisRound = before?.state === "running" && roundStart.current !== null ? status.tagged - roundStart.current : 0;
      roundStart.current = null;
      if (taggedThisRound > 0) toast.show({ title: `自动标签：新打了 ${taggedThisRound} 张`, tone: "success" });
    }
    if (status.state === "noDevice" && !unavailable.current.has(status.reason)) {
      unavailable.current.add(status.reason);
      toast.show({ title: `自动标签不可用：${status.reason}`, timeout: 0 });
    }
    // 代码收起的通知先清掉记录，onClose 才不把它当成画师关掉的。
    const closeDownload = () => {
      const id = download.current;
      download.current = null;
      if (id !== null) toast.close(id);
    };
    if (status.state !== "needsDownload") return closeDownload();
    // 画师取消了下载（#213）：和关掉通知一样，本次启动内不再弹。
    if (status.cancelled) declined.current.add(libraryId);
    if (download.current !== null || declined.current.has(libraryId)) return;
    const start = () => {
      closeDownload();
      void taggingDownload(libraryId).then(
        () => toast.show({ title: "正在下载自动标签模型" }),
        (e) => toast.error(`无法下载自动标签模型：${String(e)}`),
      );
    };
    const id = toast.show({
      title: `需要下载自动标签模型（${mb(status.size)}）`, timeout: 0,
      action: { label: status.downloaded > 0 ? "继续下载" : "下载", onClick: start },
      onClose: () => {
        if (download.current !== id) return;
        download.current = null;
        declined.current.add(libraryId);
      },
    });
    download.current = id;
  }, [toast, libraryId, status]);
}

/**
 * 自动标签在主窗口的位置（#144）：图片墙右下角、缩放滑块左边的小图标。下载、加载、打标时转动，
 * 暂停时静止半透明，其他状态不显示；悬停看进度，点击打开设置 › 自动标签。
 * 跟随后端唯一的可写资料库（ADR-0008）。
 */
export function TaggingActivity({ libraryId: opened, registered, onOpenSettings, collapsed = false }: {
  libraryId: string;
  registered?: readonly string[];
  onOpenSettings: () => void;
  /** 多选悬浮栏出现、右下角收成一个圆形按钮时（#180）：图标换成按钮右上角的小圆点，状态仍看得到。 */
  collapsed?: boolean;
}) {
  const { libraryId, status } = useTaggingStatus(opened, registered);
  useTaggingNotices(libraryId, status);
  const text = status && activityLabel(status);
  if (!status || !text) return null;
  const activity = status.state === "paused" || status.state === "yieldedToFullScreen" ? "paused" : "busy";
  if (collapsed) return <span className="k-tagging-dot" data-activity={activity} role="img" title={text} aria-label={`自动标签：${text}`} />;
  return (
    <button type="button" className="k-tagging-activity" data-activity={activity}
      title={text} aria-label={`自动标签：${text}，打开自动标签设置`} onClick={onOpenSettings}>
      <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
