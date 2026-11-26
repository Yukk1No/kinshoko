// 详情面板跟着选择与查看器走：选择或正在看的图一变，面板不能无声消失，也不能留着别的图的内容。
import { afterEach, beforeEach, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { appStartup } from "./App.fixtures";
import type { WorkspaceCard } from "./bindings/WorkspaceCard";
import type { WorkspaceSource } from "./bindings/WorkspaceSource";
import { fakeBackend, shellSettings } from "./test/backend";

export const libraries = [
  { library: { id: "L1", name: "甲库", root: "A" }, unavailable: null },
  { library: { id: "L2", name: "乙库", root: "B" }, unavailable: null },
];
export const status = { revision: "r1", libraries };
export const source = (libraryId: string, imageId: string): WorkspaceSource => ({
  libraryId,
  libraryName: libraryId,
  imageId,
  unavailable: null,
  matches: true,
  deleted: false,
});
export const card = (id: string, ...sources: WorkspaceSource[]): WorkspaceCard => ({
  id,
  libraryId: sources[0].libraryId,
  imageId: sources[0].imageId,
  width: 100,
  height: 100,
  adult: false,
  sources,
});
const wallCards = [
  card("a1", source("L1", "i1")),
  card("a2", source("L1", "i2")),
  card("b1", source("L2", "j1")),
  card("both", source("L1", "m1"), source("L2", "m2")),
];
const outside = card("out", source("L1", "e1"), source("L2", "e2"));

type Args = Record<string, string>;
/** 用例改写的回答，按命令名；返回 `undefined` 时照下面的默认回答。 */
export type Override = Record<string, (args: Args) => unknown>;

export function backend(override: Override = {}, shown = true) {
  const state = { cards: wallCards, open: null as unknown, shown, reads: [] as string[] };
  const view = () => shellSettings({ viewerBackground: "mid", inspectorOpen: state.shown });
  const replies: Override = {
    safe_mode: () => false,
    registered_libraries: () => libraries,
    workspace_status: () => status,
    workspace_directories: () => ({
      status,
      registrationOrder: [],
      providers: libraries.map((registration) => ({
        registration,
        sidebar: { all: 1, trash: 0, folders: [] },
        unassigned: 0,
        descendants: {},
      })),
    }),
    workspace_tag_groups: () => [],
    import_tasks: () => [],
    reference_groups: () => [],
    workspace_candidates: () => [],
    workspace_browse: () => ({ cards: state.cards, total: state.cards.length, nextCursor: null, status }),
    workspace_card: (args) =>
      args.imageId === "m2"
        ? card("both", source("L2", "m2"), source("L1", "m1"))
        : args.imageId === "f1"
          ? card("out2", source("L1", "f1"))
          : outside,
    image: (args) => {
      state.reads.push(args.imageId);
      return {
        id: args.imageId,
        originalName: `${args.libraryId}/${args.imageId}`,
        width: 1,
        height: 1,
        collectedAt: 1000,
        sourceLinks: [],
        folders: [],
        note: { manual: null, sources: [] },
        deletedAt: null,
        versions: { previous: null, newer: [] },
        rating: { imageId: args.imageId, suggested: null, manual: null, effective: null },
      };
    },
    catalog_image_tags: (args) => ({ image: { imageId: args.imageId, tags: [], rejected: [] }, identities: [] }),
    workspace_sidebar: () => ({ all: 1, trash: 0, folders: [] }),
    take_open_request: () => {
      const next = state.open;
      state.open = null;
      return next;
    },
    // 启动时取走留给主窗口的收集请求：没有。
    ...appStartup,
    tagging_status: () => ({ state: "starting" }),
    shell_settings: view,
    "change_setting:inspectorOpen": (args) => {
      state.shown = (args as unknown as { open: boolean }).open;
      return view();
    },
    app_info: () => ({ productName: "Kinshoko", version: "1" }),
    // 没有上次打开的图库要接着打开。
    current_library: () => null,
  };
  for (const [command, reply] of Object.entries(override)) {
    const fallback = replies[command];
    replies[command] = (args) => {
      const answer = reply(args);
      return answer !== undefined ? answer : (fallback?.(args) ?? null);
    };
  }
  fakeBackend(replies);
  return state;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

export const tile = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
export const panel = () => document.querySelector<HTMLElement>("aside.inspector");
export const opened = () => panel()?.dataset.collapsed === "false";
/** 面板里读到的文件名是“图库/图片”，所以它同时说明了整理的是哪个图库的哪一份。 */
export const shows = (name: string) =>
  waitFor(() => expect(panel()?.querySelector(".insp-file-name")?.textContent).toBe(name));
export async function start(override?: Parameters<typeof backend>[0], shown = true) {
  const state = backend(override, shown);
  render(<App />);
  await waitFor(() => expect(tile("a1")).toBeTruthy());
  await waitFor(() => expect(opened()).toBe(shown));
  return state;
}
export const wallWidth = () => tile("a1").style.width;
export const viewer = () => screen.getByRole("region", { name: "原图查看器" });
export const viewed = (src: string) =>
  waitFor(() => expect(viewer().querySelector("img")?.getAttribute("src")).toBe(`http://thumb.localhost/${src}/full`));
export async function openReference(state: ReturnType<typeof backend>, libraryId: string, imageId: string) {
  state.open = { kind: "reference", libraryId, imageId };
  await act(() => emit("open-in-kinshoko"));
  await screen.findByRole("region", { name: "原图查看器" });
  await viewed(`${libraryId}/${imageId}`);
}
