import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceQuery } from "../bindings/WorkspaceQuery";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import { Wall } from "./Wall";

type Call = { query: WorkspaceQuery; safeMode: boolean; resolve: (page: WorkspacePage) => void };
let calls: Call[];
const card: WorkspaceCard = { id: "bytes", width: 120, height: 90, adult: false, thumbnail: "A/a/256",
  libraryId: "A", imageId: "a", sources: [
    { libraryId: "A", libraryName: "甲库", imageId: "a", unavailable: null, matches: true, deleted: false },
    { libraryId: "B", libraryName: "乙库", imageId: "b", unavailable: "离线", matches: false, deleted: false },
  ] };
const page = (cards: WorkspaceCard[]): WorkspacePage => ({ cards, total: cards.length, nextCursor: null,
  status: { revision: "r", libraries: [] } });
const base = { libraryId: "active-write-target", scope: { kind: "all" as const }, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false };
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
beforeEach(() => {
  calls = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((command, args) => {
    if (command !== "plugin:library|workspace_browse") throw new Error(command);
    return new Promise<WorkspacePage>((resolve) => calls.push({ ...(args as { query: WorkspaceQuery; safeMode: boolean }), resolve }));
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

it("工作区使用范围查询并将全部来源交给检查入口，活动写入库不参与读取选择", async () => {
  const inspect = vi.fn();
  const open = vi.fn();
  render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode onInspectSources={inspect} onOpenImage={open} />);
  await settle();
  expect(calls[0].query.scope).toEqual({ kind: "all" });
  await act(async () => calls[0].resolve(page([card])));
  fireEvent.click(await screen.findByRole("button", { name: "查看 2 份资料库来源" }));
  expect(inspect).toHaveBeenCalledWith(card);
  expect(open).not.toHaveBeenCalled();
  expect(document.querySelector(".card")?.getAttribute("data-id")).toBe("bytes");
});

it("目录或提供方修订刷新时清掉旧卡片，迟到的旧页不写回", async () => {
  const view = render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  view.rerender(<Wall {...base} reloadKey={1} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  await act(async () => calls[1].resolve(page([])));
  await act(async () => calls[0].resolve(page([card])));
  expect(document.querySelector(".card")).toBeNull();
  expect(document.querySelector<HTMLElement>(".wall")?.dataset.total).toBe("0");
});

it("安全模式和资料库范围改变时，旧候选页立即作废", async () => {
  const view = render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode={false} />);
  await settle();
  view.rerender(<Wall {...base} reloadKey={1} workspaceScope={{ kind: "library", libraryId: "A", scope: { kind: "all" } }} safeMode />);
  await settle();
  expect(calls.at(-1)).toMatchObject({ safeMode: true, query: { scope: { kind: "library", libraryId: "A" } } });
  await act(async () => calls.at(-1)!.resolve(page([])));
  await act(async () => calls[0].resolve(page([{ ...card, adult: true }])));
  expect(document.querySelector(".card")).toBeNull();
});
