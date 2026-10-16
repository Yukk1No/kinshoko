// #77 UI-A / S4：图片墙只接受当前视角、当前请求的浏览响应；分页游标过期时从第一页重读。
// IPC 用受控 Promise 决定响应先后。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { BrowsePage } from "../bindings/BrowsePage";
import type { BrowseQuery } from "../bindings/BrowseQuery";
import { Wall } from "./Wall";

type Call = { query: BrowseQuery; resolve: (page: BrowsePage) => void; reject: (e: unknown) => void };
let calls: Call[];

beforeEach(() => {
  calls = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return new Promise<BrowsePage>((resolve, reject) => {
      calls.push({ query: (args as { query: BrowseQuery }).query, resolve, reject });
    });
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

const card = (id: string, adult = false) => ({ id, width: 100, height: 100, thumbnail: `L1/${id}/256`, adult });
const page = (cards: ReturnType<typeof card>[], total: number, nextCursor: string | null = null): BrowsePage =>
  ({ cards, total, nextCursor });

const base = {
  libraryId: "L1", scope: { kind: "all" as const }, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false,
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const wall = () => document.querySelector<HTMLElement>(".wall")!;
const shown = () => [...document.querySelectorAll<HTMLElement>(".card")].map((c) => c.dataset.id);

it("安全模式开启后，先发的旧浏览响应迟到也不放回成人卡片与数量（B→A）", async () => {
  const view = render(<Wall {...base} reloadKey={0} safeMode={false} />);
  await settle();
  expect(calls).toHaveLength(1); // A：关着安全模式发出
  view.rerender(<Wall {...base} reloadKey={1} safeMode />);
  await settle();
  expect(calls).toHaveLength(2); // B：开启后重新浏览

  await act(async () => calls[1].resolve(page([], 0)));
  await act(async () => calls[0].resolve(page([card("adult", true)], 1)));
  await settle();

  expect(wall().dataset.total).toBe("0");
  expect(shown()).toEqual([]);
  expect(document.querySelector(".wall-empty")).not.toBeNull();
});

it("安全模式切换的一刻作废还在路上的请求，即使新的浏览还没发出", async () => {
  const view = render(<Wall {...base} reloadKey={0} safeMode={false} />);
  await settle();
  view.rerender(<Wall {...base} reloadKey={0} safeMode />);
  await act(async () => calls[0].resolve(page([card("adult", true)], 1)));
  await settle();
  expect(shown()).toEqual([]);
  expect(wall().dataset.total).toBeUndefined();

  // 资料库确认切换后按新视角重新浏览，当前响应正常显示。
  view.rerender(<Wall {...base} reloadKey={1} safeMode />);
  await settle();
  await act(async () => calls[calls.length - 1].resolve(page([card("g")], 1)));
  await settle();
  expect(shown()).toEqual(["g"]);
  expect(wall().dataset.total).toBe("1");
});

it("旧视角的失败响应迟到不显示错误", async () => {
  const view = render(<Wall {...base} reloadKey={0} safeMode={false} />);
  await settle();
  view.rerender(<Wall {...base} reloadKey={1} safeMode />);
  await settle();
  await act(async () => calls[1].resolve(page([card("g")], 1)));
  await act(async () => calls[0].reject("资料库数据库出错"));
  await settle();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(shown()).toEqual(["g"]);
});

it("翻页请求在视角变化后迟到，不追加卡片、不改游标与数量", async () => {
  const view = render(<Wall {...base} reloadKey={0} safeMode={false} />);
  await settle();
  await act(async () => calls[0].resolve(page([card("g1")], 2, "c1")));
  await settle();
  // 墙很矮，立即接着翻页。
  const more = calls.findIndex((c) => c.query.cursor === "c1");
  expect(more).toBeGreaterThan(0);

  view.rerender(<Wall {...base} reloadKey={1} safeMode />);
  await settle();
  const reload = calls.length - 1;
  expect(calls[reload].query.cursor).toBeNull();
  await act(async () => calls[reload].resolve(page([card("g1")], 1)));
  await act(async () => calls[more].resolve(page([card("adult", true)], 2)));
  await settle();
  expect(shown()).toEqual(["g1"]);
  expect(wall().dataset.total).toBe("1");

  // 迟到的失败同样不显示。
  view.rerender(<Wall {...base} reloadKey={2} safeMode />);
  await settle();
  await act(async () => calls[calls.length - 1].resolve(page([card("g1")], 2, "c2")));
  await settle();
  const more2 = calls.length - 1;
  expect(calls[more2].query.cursor).toBe("c2");
  view.rerender(<Wall {...base} reloadKey={2} safeMode={false} />);
  await act(async () => calls[more2].reject("资料库数据库出错"));
  await settle();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("被作废的请求不会让后续翻页一直以为还在加载", async () => {
  const view = render(<Wall {...base} reloadKey={0} safeMode />);
  await settle();
  view.rerender(<Wall {...base} reloadKey={1} safeMode />);
  await settle();
  // A 永远不回来；B 带着下一页游标回来后应能接着翻页。
  await act(async () => calls[1].resolve(page([card("g1")], 2, "c1")));
  await settle();
  expect(calls.some((c) => c.query.cursor === "c1")).toBe(true);
});

it("卸载后迟到的响应不再写回", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<Wall {...base} reloadKey={0} safeMode />);
  await settle();
  view.unmount();
  await act(async () => calls[0].resolve(page([card("g")], 1)));
  await settle();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

it("翻页游标过期时从第一页重读，不显示错误", async () => {
  render(<Wall {...base} reloadKey={0} safeMode />);
  await settle();
  await act(async () => calls[0].resolve(page([card("g2")], 2, "c1")));
  await settle();
  const more = calls.length - 1;
  expect(calls[more].query.cursor).toBe("c1");
  await act(async () => calls[more].reject("浏览结果已变化，请从头重新浏览"));
  await settle();
  const again = calls.length - 1;
  expect(again).toBeGreaterThan(more);
  expect(calls[again].query.cursor).toBeNull();
  await act(async () => calls[again].resolve(page([card("g3"), card("g2"), card("g1")], 3)));
  await settle();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(shown()).toEqual(["g3", "g2", "g1"]);
  expect(wall().dataset.total).toBe("3");
});
