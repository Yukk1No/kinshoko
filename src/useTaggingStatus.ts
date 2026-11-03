import { useEffect, useState } from "react";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { onTaggingStatus, taggingStatus } from "./ipc";

/**
 * 自动标签的状态。后端全设备一个打标调度，覆盖所有资料库（ADR-0008 修订，#414）：状态是各库合计，
 * 不跟着哪个资料库走。还没读到时为 null。
 */
export function useTaggingStatus(): TaggingStatus | null {
  const [status, setStatus] = useState<TaggingStatus | null>(null);
  useEffect(() => {
    let alive = true;
    // 推送比首次读取先到时，不拿读到的旧状态盖掉它。
    let pushed = false;
    taggingStatus().then(
      (s) => alive && !pushed && setStatus(s),
      () => {},
    );
    const unlisten = onTaggingStatus((s) => {
      if (!alive) return;
      pushed = true;
      setStatus(s);
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);
  return status;
}
