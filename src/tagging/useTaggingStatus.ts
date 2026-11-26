import type { TaggingStatus } from "../bindings/TaggingStatus";
import { onTaggingStatus, taggingStatus } from "../ipc";
import { createBackendMirror, type BackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";

type KnownDevice = Pick<Extract<TaggingStatus, { state: "running" }>, "device" | "gpu">;
type TaggingMemory = {
  device: KnownDevice | null;
  model: string | null;
  remaining: number | null;
};
type TaggingMirrorValue = { status: TaggingStatus; memory: TaggingMemory };

const KEY = "tagging-status";
const emptyMemory: TaggingMemory = {
  device: null,
  model: null,
  remaining: null,
};

/** 状态里没有打标进度时，仍记住最近一次知道的设备、模型与剩余张数；状态明确作废时清空。 */
function rememberedMemory(memory: TaggingMemory, next: TaggingStatus): TaggingMemory {
  if (next.state === "running" || next.state === "idle") {
    return {
      device: { device: next.device, gpu: next.gpu },
      model: next.model,
      remaining: next.state === "running" ? next.remaining : null,
    };
  }
  if (next.state === "starting" && next.device) {
    return {
      ...memory,
      device: {
        device: next.device,
        gpu: next.device === "directMl" && memory.device?.device === "directMl" ? memory.device.gpu : null,
      },
    };
  }
  if (next.state === "preparing" && next.model !== memory.model) return { ...memory, device: null };
  if (!["paused", "yieldedToFullScreen", "starting", "preparing"].includes(next.state)) return emptyMemory;
  return memory;
}

/**
 * 打标状态的后端镜像（#761）。事件携带完整状态；镜像值同时带着由它推导出的记忆，
 * 因此先发出的旧读取回来后不能盖掉推送，也不能把记忆倒回上一次状态之前。
 */
const statusMirror = (() => {
  let self: BackendMirror<typeof KEY, TaggingMirrorValue>;
  const valueFor = (next: TaggingStatus): TaggingMirrorValue => ({
    status: next,
    memory: rememberedMemory(self.snapshot(KEY).value?.memory ?? emptyMemory, next),
  });
  self = createBackendMirror<typeof KEY, TaggingMirrorValue>({
    read: async () => valueFor(await taggingStatus()),
    listen: (_invalidate, accept) => onTaggingStatus((status) => accept(KEY, valueFor(status))),
  });
  return self;
})();

export function forgetTaggingDevice() {
  const current = statusMirror.snapshot(KEY).value;
  if (!current) return;
  statusMirror.accept(KEY, {
    ...current,
    memory: { ...current.memory, device: null },
  });
}

export function useTaggingMemory() {
  return useBackendMirror(statusMirror, KEY).value?.memory ?? emptyMemory;
}

/**
 * 自动标签的状态。后端全设备一个打标调度，覆盖所有资料库（ADR-0008 修订，#414）：状态是各库合计，
 * 不跟着哪个资料库走。还没读到时为 null。
 */
export function useTaggingStatus(): TaggingStatus | null {
  return useBackendMirror(statusMirror, KEY).value?.status ?? null;
}
