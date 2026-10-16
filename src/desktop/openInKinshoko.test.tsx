import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { OpenInKinshoko } from "../bindings/OpenInKinshoko";

// 钉图菜单“在 Kinshoko 中打开”（#106）在主窗口这一侧的接线。IPC 用替身。
const ipc = vi.hoisted(() => ({
  pending: [] as (OpenInKinshoko | null)[],
  event: null as (() => void) | null,
}));
vi.mock("../ipc", () => ({
  takeOpenRequest: () => Promise.resolve(ipc.pending.shift() ?? null),
  onOpenRequest: (handler: () => void) => { ipc.event = handler; return Promise.resolve(() => {}); },
}));

import { referenceCard, useOpenInKinshoko } from "./openInKinshoko";

afterEach(() => { cleanup(); ipc.pending = []; ipc.event = null; });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

function Probe({ onOpen }: { onOpen: (r: OpenInKinshoko) => void }) {
  useOpenInKinshoko(onOpen);
  return null;
}

it("主窗口刚建好时取走留着的请求", async () => {
  ipc.pending = [{ kind: "reference", libraryId: "L1", imageId: "I1" }];
  const onOpen = vi.fn();
  render(<Probe onOpen={onOpen} />);
  await settle();
  expect(onOpen).toHaveBeenCalledWith({ kind: "reference", libraryId: "L1", imageId: "I1" });
});

it("主窗口开着时收到事件再取；没有请求时什么都不做", async () => {
  const onOpen = vi.fn();
  render(<Probe onOpen={onOpen} />);
  await settle();
  expect(onOpen).not.toHaveBeenCalled();
  ipc.pending = [{ kind: "capture", captureId: "C1" }];
  ipc.event!();
  await settle();
  expect(onOpen).toHaveBeenCalledWith({ kind: "capture", captureId: "C1" });
});

it("参考图的查看器卡片带上图库、尺寸与是否成人内容", () => {
  const detail = (effective: ImageDetail["rating"]["effective"]) =>
    ({ width: 1200, height: 800, rating: { imageId: "I1", suggested: null, manual: null, effective } }) as ImageDetail;
  expect(referenceCard("L1", "I1", detail("general"))).toEqual({
    id: "I1", imageId: "I1", libraryId: "L1", width: 1200, height: 800, thumbnail: "L1/I1/256", adult: false,
  });
  expect(referenceCard("L1", "I1", detail("explicit")).adult).toBe(true);
  expect(referenceCard("L1", "I1", detail(null)).adult).toBe(false);
});
