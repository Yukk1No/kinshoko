// 详情面板跟着选择与查看器走：选择或正在看的图一变，面板不能无声消失，也不能留着别的图的内容。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { doubleClick } from "./App.fixtures";
import type { WorkspaceCard } from "./bindings/WorkspaceCard";
import type { WorkspaceSource } from "./bindings/WorkspaceSource";

const libraries = [
  { library: { id: "L1", name: "甲库", root: "A" }, unavailable: null },
  { library: { id: "L2", name: "乙库", root: "B" }, unavailable: null },
];
const status = { revision: "r1", libraries };
const source = (libraryId: string, imageId: string): WorkspaceSource => ({ libraryId, libraryName: libraryId, imageId, unavailable: null, matches: true, deleted: false });
const card = (id: string, ...sources: WorkspaceSource[]): WorkspaceCard => ({ id, libraryId: sources[0].libraryId, imageId: sources[0].imageId, width: 100, height: 100, adult: false, sources });
const wallCards = [
  card("a1", source("L1", "i1")),
  card("a2", source("L1", "i2")),
  card("b1", source("L2", "j1")),
  card("both", source("L1", "m1"), source("L2", "m2")),
];
const outside = card("out", source("L1", "e1"), source("L2", "e2"));

function backend(override?: (command: string, args: Record<string, string>) => unknown) {
  const state = { cards: wallCards, open: null as unknown };
  mockIPC((command, raw) => {
    const args = raw as Record<string, string>;
    const answer = override?.(command, args);
    if (answer !== undefined) return answer;
    switch (command) {
      case "plugin:library|safe_mode": return false;
      case "plugin:library|registered_libraries": return libraries;
      case "plugin:library|workspace_status": return status;
      case "plugin:library|workspace_directories": return { status, registrationOrder: [], providers: libraries.map((registration) => ({ registration, sidebar: { all: 1, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) };
      case "plugin:library|workspace_tag_groups": case "plugin:library|import_tasks": case "plugin:desktop|reference_groups": case "plugin:library|workspace_candidates": return [];
      case "plugin:library|workspace_browse": return { cards: state.cards, total: state.cards.length, nextCursor: null, status };
      case "plugin:library|workspace_card": return args.imageId === "m2" ? card("both", source("L2", "m2"), source("L1", "m1")) : outside;
      case "plugin:library|image": return { id: args.imageId, originalName: `${args.libraryId}/${args.imageId}`, width: 1, height: 1, collectedAt: 1000, sourceLinks: [], folders: [], note: { manual: null, sources: [] }, deletedAt: null, versions: { previous: null, newer: [] }, rating: { imageId: args.imageId, suggested: null, manual: null, effective: null } };
      case "plugin:library|catalog_image_tags": return { image: { imageId: args.imageId, tags: [], rejected: [] }, identities: [] };
      case "plugin:library|workspace_sidebar": return { all: 1, trash: 0, folders: [] };
      case "plugin:desktop|take_open_request": { const next = state.open; state.open = null; return next; }
      case "tagging_status": return { state: "starting" };
      case "shell_settings": return { autostart: false, shortcuts: [], showApproxSource: false, viewerBackground: "mid" };
      case "app_info": return { productName: "Kinshoko", version: "1" };
      default: return null;
    }
  }, { shouldMockEvents: true });
  return state;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows"); mockWindows("main");
});
afterEach(async () => { cleanup(); await new Promise((done) => setTimeout(done, 0)); clearMocks(); vi.unstubAllGlobals(); });

const tile = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
const panel = () => document.querySelector<HTMLElement>("aside.inspector");
const opened = () => panel()?.dataset.collapsed === "false";
/** 面板里读到的文件名是“图库/图片”，所以它同时说明了整理的是哪个图库的哪一份。 */
const shows = (name: string) => waitFor(() => expect(panel()?.querySelector(".insp-file-name")?.textContent).toBe(name));
async function start(override?: Parameters<typeof backend>[0]) {
  const state = backend(override);
  render(<App />);
  await waitFor(() => expect(tile("a1")).toBeTruthy());
  return state;
}
const viewer = () => screen.getByRole("region", { name: "原图查看器" });
const viewed = (src: string) => waitFor(() => expect(viewer().querySelector("img")?.getAttribute("src")).toBe(`http://thumb.localhost/${src}/full`));
async function openReference(state: ReturnType<typeof backend>, libraryId: string, imageId: string) {
  state.open = { kind: "reference", libraryId, imageId };
  await act(() => emit("open-in-kinshoko"));
  await screen.findByRole("region", { name: "原图查看器" });
  await viewed(`${libraryId}/${imageId}`);
}

describe("选择变化时", () => {
  it.each([["跨图库", "b1"], ["含几个图库各有一份的图", "both"]])("多选%s：定不下整理哪个图库，不显示详情面板，选择不动；退回单选后面板回来", async (_, other) => {
    await start();
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    fireEvent.click(tile(other), { ctrlKey: true });
    await waitFor(() => expect(panel()).toBeNull());
    expect(tile("a1").getAttribute("aria-selected")).toBe("true");
    expect(tile(other).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tile(other), { ctrlKey: true });
    await shows("L1/i1");
    expect(opened()).toBe(true);
  });

  it("单选在两个图库各有一份的图走来源整理，取消加选后回到它", async () => {
    await start();
    fireEvent.click(tile("both"));
    await shows("L1/m1");
    expect(panel()!.querySelector(".workspace-sources")).toBeTruthy();
    fireEvent.click(tile("a1"), { ctrlKey: true });
    fireEvent.click(tile("a1"), { ctrlKey: true });
    await shows("L1/m1");
    expect(opened()).toBe(true);
  });

  it("收起面板只对收起时的那组选择有效：选过别的再选回来，面板打开", async () => {
    await start();
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
    expect(opened()).toBe(false);
    fireEvent.click(tile("a2"));
    await shows("L1/i2");
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    expect(opened()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
    fireEvent.click(document.querySelector<HTMLElement>(".wall-canvas")!);
    expect(panel()).toBeNull();
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    expect(opened()).toBe(true);
  });

  it("来源按钮打开的整理在画师改选别的图后让位，同一图库的多选悬浮栏也能出来", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "在 2 个图库，查看详情" }));
    await shows("L1/m1");
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    expect(panel()!.dataset.selection).toBe("a1");
    fireEvent.click(tile("a2"), { ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("toolbar", { name: "已选参考图操作" })).toBeTruthy());
  });
});

describe("图片墙重新读取时", () => {
  /** 按文字查找时条件树一变，图片墙整个重挂、先清空卡片，而选择还在。 */
  async function searching(select: string) {
    let resolved = 0;
    let release: ((page: unknown) => void) | null = null;
    const state = await start((command) => {
      if (command === "plugin:library|workspace_resolve") {
        resolved += 1;
        return { conditions: [{ negate: false, any: [{ kind: "text", text: `蓝${resolved}`, tags: [], similar: [], ratings: [] }] }] };
      }
      if (command === "plugin:library|workspace_browse" && resolved > 1 && !release) return new Promise((done) => { release = done; });
      return undefined;
    });
    const input = screen.getByRole("combobox", { name: "查找参考图" });
    fireEvent.change(input, { target: { value: "蓝" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(resolved).toBe(1));
    await waitFor(() => expect(tile(select)).toBeTruthy());
    fireEvent.click(tile(select));
    return {
      remount: async () => {
        await act(() => emit("library-event", { kind: "vocabularyChanged", libraryId: "L1" }));
        await waitFor(() => expect(release).not.toBeNull());
        await waitFor(() => expect(tile(select)).toBeNull());
      },
      finish: () => act(async () => { release!({ cards: state.cards, total: state.cards.length, nextCursor: null, status }); }),
    };
  }

  it("普通详情不变空", async () => {
    const wall = await searching("a1");
    await shows("L1/i1");
    await wall.remount();
    await shows("L1/i1");
    await wall.finish();
    await waitFor(() => expect(tile("a1").getAttribute("aria-selected")).toBe("true"));
    await shows("L1/i1");
  });

  it("来源整理不卸载，画师切到的那份不丢", async () => {
    const wall = await searching("both");
    await shows("L1/m1");
    fireEvent.click(screen.getByRole("button", { name: "L2" }));
    await shows("L2/m2");
    const sources = panel()!.querySelector(".workspace-sources");
    await wall.remount();
    expect(panel()!.querySelector(".workspace-sources")).toBe(sources);
    await wall.finish();
    await waitFor(() => expect(tile("both").getAttribute("aria-selected")).toBe("true"));
    await shows("L2/m2");
  });
});

describe("查看器里", () => {
  it("换到跨图库的图、多份来源的图时侧栏跟随，隐藏一直延续到退出", async () => {
    await start();
    doubleClick(tile("a1"));
    await viewed("L1/i1");
    fireEvent.keyDown(viewer(), { key: "ArrowRight" });
    await shows("L1/i2");
    fireEvent.keyDown(viewer(), { key: "ArrowRight" });
    await shows("L2/j1");
    fireEvent.keyDown(viewer(), { key: "i" });
    expect(opened()).toBe(false);
    fireEvent.keyDown(viewer(), { key: "ArrowRight" });
    await viewed("L1/m1");
    await shows("L1/m1");
    expect(panel()!.querySelector(".workspace-sources")).toBeTruthy();
    expect(opened()).toBe(false);
    fireEvent.keyDown(viewer(), { key: "Escape" });
    expect(opened()).toBe(false);
    expect(panel()!.dataset.selection).toBe("both");
  });

  it("看墙外的图时 I 键能隐藏也能再显示，没有选择时面板不消失", async () => {
    const state = await start();
    await openReference(state, "L1", "e1");
    await shows("L1/e1");
    fireEvent.keyDown(viewer(), { key: "i" });
    expect(opened()).toBe(false);
    fireEvent.keyDown(viewer(), { key: "i" });
    expect(opened()).toBe(true);
    await shows("L1/e1");
    fireEvent.keyDown(viewer(), { key: "Escape" });
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("看墙外的图时不管怎么收起再打开，面板都不换成图片墙上选中的那张，退出才回去", async () => {
    const state = await start();
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    await openReference(state, "L1", "e1");
    await shows("L1/e1");
    for (const hide of [
      () => fireEvent.keyDown(viewer(), { key: "i" }),
      () => fireEvent.click(screen.getByRole("button", { name: "收起详情" })),
    ]) {
      hide();
      expect(opened()).toBe(false);
      expect(panel()!.dataset.selection).toBe("out");
      fireEvent.keyDown(viewer(), { key: "i" });
      expect(opened()).toBe(true);
      await shows("L1/e1");
    }
    fireEvent.keyDown(viewer(), { key: "Escape" });
    await shows("L1/i1");
    expect(opened()).toBe(true);
  });

  it("画师已收起面板时打开墙外的图也保持收起，退出后选择的面板仍收起", async () => {
    const state = await start();
    fireEvent.click(tile("a1"));
    await shows("L1/i1");
    fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
    await openReference(state, "L1", "e1");
    expect(opened()).toBe(false);
    fireEvent.keyDown(viewer(), { key: "Escape" });
    await waitFor(() => expect(panel()!.dataset.selection).toBe("a1"));
    expect(opened()).toBe(false);
  });

  it("钉图打开墙上这张图的另一份时，详情也是那一份，退出后回到图片墙代表的那份", async () => {
    const state = await start();
    await openReference(state, "L2", "m2");
    await shows("L2/m2");
    fireEvent.keyDown(viewer(), { key: "Escape" });
    await shows("L1/m1");
  });
});
