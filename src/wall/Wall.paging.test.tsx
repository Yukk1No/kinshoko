// 图片墙只经工作区浏览分页（#363）：范围、查找条件与安全模式随每一页的查询一起传；
// 重新浏览取到一半游标过期时从第一页重取。IPC 用受控 Promise 决定响应先后。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceQuery } from "../bindings/WorkspaceQuery";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { type CardSeed, workspacePage } from "../test/workspacePage";
import { Wall, type WallHandle } from "./Wall";
import { PAGE } from "./wallShared";

type Call = { query: WorkspaceQuery; safeMode: boolean; resolve: (page: WorkspacePage) => void; reject: (e: unknown) => void };
let calls: Call[];

beforeEach(() => {
  calls = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:library|workspace_browse") throw new Error(cmd);
    return new Promise<WorkspacePage>((resolve, reject) => {
      calls.push({ ...(args as { query: WorkspaceQuery; safeMode: boolean }), resolve, reject });
    });
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

const EXPIRED = { code: "cursorExpired" };
const EXPIRED_TEXT = "浏览结果已变化，请从头重新浏览";
const card = (id: string): CardSeed => ({ id, width: 100, height: 100 });
const folder: WorkspaceScope = { kind: "library", libraryId: "L2", scope: { kind: "folder", id: "F" } };
const tree: ConditionTree = { conditions: [{ any: [{ kind: "text", text: "手", tags: [], similar: [], ratings: [] }], negate: false }] };
const base = {
  workspaceScope: folder, scope: { kind: "folder" as const, id: "F" }, conditions: tree, reloadKey: 0,
  selected: new Set<string>(), onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false,
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const shown = () => [...document.querySelectorAll<HTMLElement>(".card")].map((c) => c.dataset.id);
const total = () => document.querySelector<HTMLElement>(".wall")!.dataset.total;

it("翻页带着同一范围、查找条件与安全模式，下一页接在后面，张数取最新一页的", async () => {
  const status = vi.fn();
  const wall = createRef<WallHandle>();
  render(<Wall ref={wall} {...base} safeMode onWorkspaceStatus={status} />);
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ safeMode: true, query: { scope: folder, conditions: tree, cursor: null, knownPlaceholders: [] } });
  const firstPage = Array.from({ length: PAGE }, (_, i) => card(`a${i}`));
  await act(async () => calls[0].resolve(workspacePage(firstPage, PAGE + 2, "c1")));
  await settle();
  // 第一页已取够一屏，停在这里，等滚到底部再翻。
  expect(calls).toHaveLength(1);
  expect(status).toHaveBeenCalledTimes(1);
  act(() => wall.current!.loadMore());
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ safeMode: true, query: { scope: folder, conditions: tree, cursor: "c1", knownPlaceholders: [] } });
  await act(async () => calls[1].resolve(workspacePage([card("b"), card("c")], PAGE + 2)));
  await settle();
  expect(total()).toBe(String(PAGE + 2));
  // 每一页回来都把已接受的工作区快照交给父界面，带上那时墙上的全部卡片。
  expect(status).toHaveBeenCalledTimes(2);
  expect(status.mock.lastCall![1].map((c: CardSeed) => c.id)).toEqual([...firstPage.map((c) => c.id), "b", "c"]);
  // 没有下一页了：不再翻。
  act(() => wall.current!.loadMore());
  await settle();
  expect(calls).toHaveLength(2);
});

it("重新浏览取到一半游标过期：从第一页重取，不把两次取到的卡片拼在一起", async () => {
  const view = render(<Wall {...base} safeMode={false} />);
  await settle();
  await act(async () => calls[0].resolve(workspacePage([card("a")], 1)));
  await settle();
  // 修订号前进后重新浏览：一次取够墙上已有的张数，要翻好几页。
  view.rerender(<Wall {...base} safeMode={false} reloadKey={1} />);
  await settle();
  const first = calls.length - 1;
  expect(calls[first].query.cursor).toBeNull();
  await act(async () => calls[first].resolve(workspacePage([card("x")], 600, "c1")));
  await settle();
  expect(calls[first + 1].query.cursor).toBe("c1");
  await act(async () => calls[first + 1].reject(EXPIRED));
  await settle();
  const again = calls.length - 1;
  expect(again).toBe(first + 2);
  expect(calls[again].query).toMatchObject({ cursor: null, scope: folder, conditions: tree });
  // 重取之前墙上仍是原来的卡片。
  expect(shown()).toEqual(["a"]);
  await act(async () => calls[again].resolve(workspacePage([card("y"), card("x")], 2)));
  await settle();
  expect(shown()).toEqual(["y", "x"]);
  expect(total()).toBe("2");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("重新浏览一直撞上游标过期：重取几次后报错，不无限重试", async () => {
  render(<Wall {...base} safeMode={false} />);
  await settle();
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(calls).toHaveLength(attempt + 1);
    expect(calls[attempt].query.cursor).toBeNull();
    await act(async () => calls[attempt].reject(EXPIRED));
    await settle();
  }
  expect(calls).toHaveLength(4);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(EXPIRED_TEXT);
});
