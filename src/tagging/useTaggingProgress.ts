import { useEffect, useRef, useState } from "react";
import type { FailedTagging } from "../bindings/FailedTagging";
import type { TaggingStatus } from "../bindings/TaggingStatus";

/** 估算用的最近几张。 */
const SAMPLES = 8;
/** 打完这么多张之后才估算：开头几张含加载，不准。 */
const MIN_SAMPLES = 3;

/** 还剩几张与预计还要多久（毫秒）。 */
export type TaggingProgress = { remaining: number | null; eta: number | null };

/**
 * 按最近几张的用时估算还要多久（#475）。打完几张之前没有估算；暂停时留着暂停前的张数与估算，
 * 暂停的时间不算进用时；打完或停住时清掉。
 */
export function useTaggingProgress(status: TaggingStatus | null): TaggingProgress {
  const samples = useRef<number[]>([]);
  const last = useRef<{ done: number; at: number } | null>(null);
  const [progress, setProgress] = useState<TaggingProgress>({ remaining: null, eta: null });
  useEffect(() => {
    if (!status) return;
    if (status.state === "paused" || status.state === "yieldedToFullScreen") {
      last.current = null;
      return;
    }
    if (status.state !== "running") {
      samples.current = [];
      last.current = null;
      setProgress({ remaining: null, eta: null });
      return;
    }
    const now = performance.now();
    const before = last.current;
    if (before && status.done > before.done) {
      const each = (now - before.at) / (status.done - before.done);
      samples.current = [...samples.current, each].slice(-SAMPLES);
    }
    last.current = { done: status.done, at: now };
    const known = samples.current;
    const eta =
      known.length >= MIN_SAMPLES ? (known.reduce((a, b) => a + b, 0) / known.length) * status.remaining : null;
    setProgress({ remaining: status.remaining, eta });
  }, [status]);
  return progress;
}

const IGNORED_KEY = "kinshoko.tagging.ignoredUnfinished";

function readIgnored(): number {
  try {
    const value = Number(localStorage.getItem(IGNORED_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeIgnored(count: number) {
  try {
    localStorage.setItem(IGNORED_KEY, String(count));
  } catch {
    // 忽略失败：本机存储不可用时只是记不住，下次启动再显示。
  }
}

/**
 * 没有完成的图要不要在右下角常驻（#475）：画师“忽略”时记下当时的张数（存在本机），之后张数超过它才再显示。
 * 重试打上了、张数变少时跟着调低，之后新出现的又能显示。`failed` 只在空闲时知道，其余时候为 null。
 */
export function useUnfinishedTagging(failed: FailedTagging | null) {
  const [ignored, setIgnored] = useState(readIgnored);
  const total = failed ? failed.unreadable + failed.crashed : null;
  useEffect(() => {
    if (total !== null && total < ignored) {
      setIgnored(total);
      writeIgnored(total);
    }
  }, [total, ignored]);
  return {
    shown: total !== null && total > ignored,
    ignore: () => {
      if (total === null) return;
      setIgnored(total);
      writeIgnored(total);
    },
  };
}
