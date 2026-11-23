import { useSyncExternalStore } from "react";
import type { TaggingStatus } from "../bindings/TaggingStatus";
import { onTaggingStatus, taggingStatus } from "../ipc";

type KnownDevice = Pick<Extract<TaggingStatus, { state: "running" }>, "device" | "gpu">;
const emptyMemory = { device: null as KnownDevice | null, remaining: null as number | null };
let memory = emptyMemory;
let status: TaggingStatus | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
const notify = () => {
  for (const listener of listeners) listener();
};

export function forgetTaggingDevice() {
  memory = { ...memory, device: null };
  notify();
}

function update(next: TaggingStatus) {
  status = next;
  if (next.state === "running" || next.state === "idle") {
    memory = {
      device: { device: next.device, gpu: next.gpu },
      remaining: next.state === "running" ? next.remaining : null,
    };
  } else if (!["paused", "yieldedToFullScreen", "starting", "preparing"].includes(next.state)) {
    memory = emptyMemory;
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stop) {
    let alive = true;
    let pushed = false;
    const unlisten = onTaggingStatus((next) => {
      if (!alive) return;
      pushed = true;
      update(next);
    });
    taggingStatus().then(
      (next) => {
        if (alive && !pushed) update(next);
      },
      () => {},
    );
    stop = () => {
      alive = false;
      void unlisten.then((unlisten) => unlisten());
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
      status = null;
      memory = emptyMemory;
    }
  };
}

export function useTaggingMemory() {
  return useSyncExternalStore(subscribe, () => memory);
}

/**
 * 自动标签的状态。后端全设备一个打标调度，覆盖所有资料库（ADR-0008 修订，#414）：状态是各库合计，
 * 不跟着哪个资料库走。还没读到时为 null。
 */
export function useTaggingStatus(): TaggingStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}
