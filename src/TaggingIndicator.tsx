import { useEffect, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { onTaggingStatus, taggingDownload, taggingPause, taggingResume, taggingStatus } from "./ipc";

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const percent = (part: number, total: number) => (total > 0 ? Math.floor((part / total) * 100) : 0);

/** 侧栏底部的自动打标卡片（#98）：图标 + 状态 + 操作；下载时显示进度条。 */
function Card({ children, progress }: { children: ReactNode; progress?: number }) {
  return <div className="tagging"><Sparkles size={14} aria-hidden="true" className="tagging-icon" /><span className="tagging-text">{children}</span>
    {progress !== undefined && <span className="tagging-prog" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>}</div>;
}

/**
 * 侧栏底部的自动标签：首次使用时显示模型大小、经画师确认后下载（可续传），
 * 显示下载与打标进度，可以暂停（结束打标子进程、归还显存）与继续。
 */
export function TaggingIndicator({ libraryId }: { libraryId: string }) {
  const [status, setStatus] = useState<TaggingStatus | null>(null);

  useEffect(() => {
    let alive = true;
    taggingStatus(libraryId).then(
      (s) => alive && s.libraryId === libraryId && setStatus(s.status),
      () => {},
    );
    const unlisten = onTaggingStatus((s) => alive && s.libraryId === libraryId && setStatus(s.status));
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [libraryId]);

  if (!status) return null;
  const act = (f: () => Promise<void>) => () => void f().catch(() => {});
  const pause = (
    <button type="button" className="k-btn is-ghost is-sm" onClick={act(() => taggingPause(libraryId))}>
      暂停
    </button>
  );

  switch (status.state) {
    // 加载模型可能要几分钟，子进程已在占用显存：开始与校验阶段同样可以暂停（#77 UI-C）。
    case "starting":
      return <Card>自动标签：正在加载打标模型… {pause}</Card>;
    case "noDevice":
      return <Card>自动标签不可用：{status.reason}</Card>;
    case "needsDownload":
      return (
        <Card>
          <button type="button" className="k-btn is-sm" onClick={act(() => taggingDownload(libraryId))}>
            {status.downloaded > 0
              ? `继续下载打标模型（已下载 ${percent(status.downloaded, status.size)}%）`
              : `下载打标模型（${mb(status.size)}）`}
          </button>
        </Card>
      );
    case "downloading":
      return (
        <Card progress={percent(status.downloaded, status.total)}>
          下载打标模型 {percent(status.downloaded, status.total)}%（{mb(status.downloaded)} /{" "}
          {mb(status.total)}）
        </Card>
      );
    case "preparing":
      return <Card>正在校验打标模型… {pause}</Card>;
    case "running":
      return (
        <Card>
          自动标签：{status.device === "directMl" ? "显卡" : "CPU"}，已打 {status.tagged} 张 {pause}
        </Card>
      );
    case "idle":
      return <Card>自动标签：已全部打完 {pause}</Card>;
    case "paused":
      return (
        <Card>
          自动标签已暂停{" "}
          <button type="button" className="k-btn is-ghost is-sm" onClick={act(() => taggingResume(libraryId))}>
            继续
          </button>
        </Card>
      );
    case "failed":
      return <Card>自动标签出错，稍后重试：{status.reason}</Card>;
  }
}
