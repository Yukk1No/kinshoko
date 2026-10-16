import { useEffect, useState } from "react";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { onTaggingStatus, taggingDownload, taggingPause, taggingResume, taggingStatus } from "./ipc";

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const percent = (part: number, total: number) => (total > 0 ? Math.floor((part / total) * 100) : 0);

/**
 * 状态栏里的自动标签：首次使用时显示模型大小、经画师确认后下载（可续传），
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
    <button type="button" onClick={act(() => taggingPause(libraryId))}>
      暂停
    </button>
  );

  switch (status.state) {
    // 加载模型可能要几分钟，子进程已在占用显存：开始与校验阶段同样可以暂停（#77 UI-C）。
    case "starting":
      return <span className="tagging">自动标签：正在加载打标模型… {pause}</span>;
    case "noDevice":
      return <span className="tagging">自动标签不可用：{status.reason}</span>;
    case "needsDownload":
      return (
        <span className="tagging">
          <button type="button" onClick={act(() => taggingDownload(libraryId))}>
            {status.downloaded > 0
              ? `继续下载打标模型（已下载 ${percent(status.downloaded, status.size)}%）`
              : `下载打标模型（${mb(status.size)}）`}
          </button>
        </span>
      );
    case "downloading":
      return (
        <span className="tagging">
          下载打标模型 {percent(status.downloaded, status.total)}%（{mb(status.downloaded)} /{" "}
          {mb(status.total)}）
        </span>
      );
    case "preparing":
      return <span className="tagging">正在校验打标模型… {pause}</span>;
    case "running":
      return (
        <span className="tagging">
          自动标签：{status.device === "directMl" ? "显卡" : "CPU"}，已打 {status.tagged} 张 {pause}
        </span>
      );
    case "idle":
      return <span className="tagging">自动标签：已全部打完 {pause}</span>;
    case "paused":
      return (
        <span className="tagging">
          自动标签已暂停{" "}
          <button type="button" onClick={act(() => taggingResume(libraryId))}>
            继续
          </button>
        </span>
      );
    case "failed":
      return <span className="tagging">自动标签出错，稍后重试：{status.reason}</span>;
  }
}
