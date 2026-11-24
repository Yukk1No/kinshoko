import { screen } from "@testing-library/react";
import type { ModelChoice } from "../bindings/ModelChoice";
import type { TaggingStatus } from "../bindings/TaggingStatus";
import { fakeBackend, type Replies } from "../test/backend";

export const choice: ModelChoice = {
  model: "PixAI Tagger v1.0",
  selected: null,
  options: [
    { device: "directMl", vramNeed: 1_800_000_000, ramNeed: 0, size: 992_916_002, downloaded: true },
    { device: "cpu", vramNeed: 0, ramNeed: 5_000_000_000, size: 1_984_062_544, downloaded: false },
  ],
};

/** 自动标签设置的假后端：读回 `status` 与 `models`，其余命令照 `replies`。 */
export function backend({
  status = { state: "paused" } as TaggingStatus,
  models = choice,
  replies = {} as Replies,
} = {}) {
  return fakeBackend({ tagging_models: models, tagging_status: status, ...replies });
}

export const statusRow = () => screen.getByRole("listitem", { name: "状态" });
export const hardware = () => screen.findByRole("combobox", { name: "硬件加速" });

export const running: Extract<TaggingStatus, { state: "running" }> = {
  state: "running",
  model: "x",
  device: "cpu",
  gpu: null,
  tagged: 5,
  done: 5,
  remaining: 138,
};
