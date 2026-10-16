import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenInKinshoko } from "../bindings/OpenInKinshoko";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

// 钉图菜单“在 Kinshoko 中打开”（#106）在主窗口这一侧的接线。IPC 用替身。
const ipc = vi.hoisted(() => ({
  pending: [] as (OpenInKinshoko | null)[],
  event: null as (() => void) | null,
  workspaceCard: vi.fn(),
}));
vi.mock("../ipc", () => ({
  takeOpenRequest: () => Promise.resolve(ipc.pending.shift() ?? null),
  onOpenRequest: (handler: () => void) => { ipc.event = handler; return Promise.resolve(() => {}); },
  workspaceCard: ipc.workspaceCard,
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

it("参考图的查看器卡片与图片墙同样构成：id 是字节身份，查看器里的整理按它核对来源", async () => {
  // 图片墙的卡片 id 是内容的字节身份，不是图库里的图片 id；整理时 contentId = card.id。
  const card: WorkspaceCard = {
    id: "sha-of-I1", width: 1200, height: 800, thumbnail: "L1/I1/256", adult: false,
    libraryId: "L1", imageId: "I1",
    sources: [{ libraryId: "L1", libraryName: "工作参考", imageId: "I1", unavailable: null, matches: true, deleted: false }],
  };
  ipc.workspaceCard.mockResolvedValueOnce(card);
  const opened = await referenceCard("L1", "I1", true);
  expect(ipc.workspaceCard).toHaveBeenCalledWith("L1", "I1", 256, true);
  expect(opened).toEqual(card);
  expect(opened.id).not.toBe(opened.imageId);
});
