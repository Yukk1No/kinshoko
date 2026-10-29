import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceQuery } from "../bindings/WorkspaceQuery";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import { DRAG_IMAGE_SOURCES, Wall } from "./Wall";

type Call = { query: WorkspaceQuery; safeMode: boolean; resolve: (page: WorkspacePage) => void };
let calls: Call[];
const card: WorkspaceCard = { id: "bytes", width: 120, height: 90, adult: false,
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
  fireEvent.click(await screen.findByRole("button", { name: "在 2 个图库，查看详情" }));
  expect(inspect).toHaveBeenCalledWith(card);
  expect(open).not.toHaveBeenCalled();
  expect(document.querySelector(".card")?.getAttribute("data-id")).toBe("bytes");
});

it("来源按钮只在图片在两个及以上图库时出现，显示“N 处”；只在一个图库的图没有按钮；按钮不在卡片选项里", async () => {
  const inspect = vi.fn();
  render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode onInspectSources={inspect} />);
  await settle();
  const single = { ...card, id: "single", imageId: "s", sources: [card.sources[0]] };
  await act(async () => calls[0].resolve(page([card, single])));
  const multi = await screen.findByRole("button", { name: "在 2 个图库，查看详情" });
  expect(multi.textContent).toBe("2 处");
  expect(document.querySelectorAll(".card-sources")).toHaveLength(1);
  expect(document.querySelector('.card-sources[data-card="single"]')).toBeNull();
  for (const option of screen.getAllByRole("option")) {
    expect(option.querySelector("button, [tabindex], a, input")).toBeNull();
  }
  expect(multi.closest("[role='option']")).toBeNull();
  expect(multi.dataset.card).toBe("bytes");
  fireEvent.click(multi);
  expect(inspect).toHaveBeenCalledWith(card);
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

it("自动打标期间修订号前进时，新一页迟迟不到也一直显示已有卡片，到了再原地替换 (#142)", async () => {
  const view = render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  await act(async () => calls[0].resolve(page([card])));
  expect(document.querySelectorAll(".card")).toHaveLength(1);
  // 每写入一张图修订号前进一次；后端排队，新一页的响应很晚才到。
  for (const key of [1, 2, 3]) {
    view.rerender(<Wall {...base} reloadKey={key} workspaceScope={{ kind: "all" }} safeMode />);
    await settle();
    expect(document.querySelectorAll(".card")).toHaveLength(1);
  }
  const tagged = { ...card, id: "tagged", imageId: "t" };
  // 先到的旧请求作废，不写回。
  await act(async () => calls[1].resolve(page([{ ...card, id: "stale" }])));
  expect(document.querySelector('[data-id="stale"]')).toBeNull();
  await act(async () => calls.at(-1)!.resolve(page([card, tagged])));
  expect([...document.querySelectorAll<HTMLElement>(".card")].map((node) => node.dataset.id)).toEqual(["bytes", "tagged"]);
  expect(document.querySelector<HTMLElement>(".wall")?.dataset.total).toBe("2");
});

it("安全模式切换时卡片留在原位：成人卡片立即遮蔽，新的一页回来后才离开 (#142, #154)", async () => {
  const adult = { ...card, id: "adult", adult: true };
  // 有封印书才有封印动画；没有时（或减少动态效果）封印的图直接离开。
  const book = document.body.appendChild(Object.assign(document.createElement("button"), { className: "seal-book" }));
  onTestFinished(() => book.remove());
  const view = render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode={false} />);
  await settle();
  await act(async () => calls[0].resolve(page([card, adult])));
  expect(document.querySelectorAll(".card")).toHaveLength(2);
  // App 切换安全模式时同时让 reloadKey 前进。封印动画要从这些卡片飞出，墙不能先空一下。
  view.rerender(<Wall {...base} reloadKey={1} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  expect([...document.querySelectorAll<HTMLElement>(".card")].map((node) => node.dataset.id)).toEqual(["bytes", "adult"]);
  // 成人卡片交给飞向封印书的影子：原地不再留着遮蔽的图，但先占着位置，资料库确认后其余卡片才补位。
  expect(document.querySelector<HTMLElement>('.card[data-id="adult"]')?.dataset.veiled).toBe("true");
  expect(document.querySelector<HTMLElement>('.card[data-id="adult"]')?.dataset.leaving).toBe("true");
  expect(document.querySelector<HTMLElement>('.card[data-id="bytes"]')?.dataset.leaving).toBe("false");
  await act(async () => calls.at(-1)!.resolve(page([card])));
  expect([...document.querySelectorAll<HTMLElement>(".card")].map((node) => node.dataset.id)).toEqual(["bytes"]);
  // 关掉安全模式同样不清空，成人卡片随新的一页回来。
  view.rerender(<Wall {...base} reloadKey={2} workspaceScope={{ kind: "all" }} safeMode={false} />);
  await settle();
  expect([...document.querySelectorAll<HTMLElement>(".card")].map((node) => node.dataset.id)).toEqual(["bytes"]);
});

it("工作区范围切换时，旧范围的卡片不再显示 (#142)", async () => {
  const view = render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  await act(async () => calls[0].resolve(page([card])));
  expect(document.querySelectorAll(".card")).toHaveLength(1);
  view.rerender(<Wall {...base} reloadKey={1} workspaceScope={{ kind: "library", libraryId: "B", scope: { kind: "all" } }} safeMode />);
  await settle();
  expect(document.querySelector(".card")).toBeNull();
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

it("再次选中同一范围（值相同的新范围对象）时，图片墙不会清空成既无卡片也无数量的状态", async () => {
  // T20 r5/r6：Eagle 步骤再次点击已选中的文件夹后，墙上没有卡片、没有数量、也没有错误。
  const folder = () => ({ kind: "library" as const, libraryId: "B", scope: { kind: "folder" as const, id: "eagle" } });
  const view = render(<Wall {...base} reloadKey={0} workspaceScope={folder()} safeMode />);
  await settle();
  await act(async () => calls[0].resolve(page([card])));
  expect(document.querySelector(".card")?.getAttribute("data-id")).toBe("bytes");

  view.rerender(<Wall {...base} reloadKey={0} workspaceScope={folder()} safeMode />);
  await settle();
  for (const call of calls.slice(1)) await act(async () => call.resolve(page([card])));
  await settle();
  expect(document.querySelector(".card")?.getAttribute("data-id")).toBe("bytes");
  expect(document.querySelector<HTMLElement>(".wall")?.dataset.total).toBe("1");
});

it("在“全部图片”里也能拖出卡片：带上每张图在各已连接图库里的 id，放进哪个库就用哪个库的 id", async () => {
  render(<Wall {...base} reloadKey={0} workspaceScope={{ kind: "all" }} />);
  await settle();
  const offline = { ...card, id: "offline", imageId: "o", sources: [card.sources[1]] };
  await act(async () => calls[0].resolve(page([card, offline])));
  await screen.findAllByRole("option");
  const node = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  expect(node("bytes").getAttribute("draggable")).toBe("true");
  expect(node("offline").getAttribute("draggable")).toBe("false");
  const data = new Map<string, string>();
  fireEvent.dragStart(node("bytes"), { dataTransfer: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" } });
  expect(JSON.parse(data.get(DRAG_IMAGE_SOURCES)!)).toEqual({ A: ["a"] });
});
