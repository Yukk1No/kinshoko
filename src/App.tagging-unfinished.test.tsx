// 查看没有完成自动标签的图（#475）：从右下角图标的右键菜单或设置 › 自动标签的“查看”回到图片墙，
// 范围是全部图库，查找框里只有可以去掉的条件块“自动标签未完成”。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { App } from "./App";
import type { SearchInput } from "./bindings/SearchInput";
import type { WorkspaceCard } from "./bindings/WorkspaceCard";

const libraries = [{ library: { id: "L1", name: "甲库", root: "A" }, unavailable: null }];
const status = { revision: "r1", libraries };
const cards: WorkspaceCard[] = [{ id: "a1", libraryId: "L1", imageId: "i1", width: 100, height: 100, adult: false,
  sources: [{ libraryId: "L1", libraryName: "甲库", imageId: "i1", unavailable: null, matches: true, deleted: false }] }];
const unfinished = { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0, unknown: 0, failed: { unreadable: 1, crashed: 0 } };

function backend() {
  const resolved: SearchInput[] = [];
  mockIPC((command, raw) => {
    const args = raw as Record<string, unknown>;
    switch (command) {
      case "plugin:library|safe_mode": return false;
      case "plugin:library|registered_libraries": return libraries;
      case "plugin:library|workspace_status": return status;
      case "plugin:library|workspace_directories": return { status, registrationOrder: [], providers: libraries.map((registration) => ({ registration, sidebar: { all: 1, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) };
      case "plugin:library|workspace_tag_groups": case "plugin:library|import_tasks": case "plugin:desktop|reference_groups": case "plugin:library|workspace_candidates": return [];
      case "plugin:library|workspace_browse": return { cards, total: cards.length, nextCursor: null, status };
      case "plugin:library|workspace_sidebar": return { all: 1, trash: 0, folders: [] };
      case "plugin:library|workspace_resolve": {
        const input = args.input as SearchInput;
        resolved.push(input);
        return { conditions: input.conditions.map((c) => ({ negate: c.negate, any: c.any.map(() => ({ kind: "taggingUnfinished" })) })) };
      }
      case "tagging_status": return unfinished;
      case "tagging_models": return { model: "x", selected: null, options: [] };
      case "shell_settings": return { autostart: false, shortcuts: [], showApproxSource: false, viewerBackground: "mid", inspectorOpen: false };
      case "app_info": return { productName: "Kinshoko", version: "1" };
      default: return null;
    }
  }, { shouldMockEvents: true });
  return resolved;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows"); mockWindows("main");
});
afterEach(async () => { cleanup(); await new Promise((done) => setTimeout(done, 0)); clearMocks(); vi.unstubAllGlobals(); });

const chips = () => screen.getByRole("list", { name: "查找条件" });
const filtered = (resolved: SearchInput[]) => waitFor(() => {
  expect(resolved.at(-1)?.conditions).toEqual([{ any: [{ kind: "taggingUnfinished" }], negate: false }]);
  expect(within(chips()).getByText("自动标签未完成")).toBeTruthy();
});

describe("查看没有完成自动标签的图（#475）", () => {
  it("右下角图标右键“查看这些图”：查找框里加上条件块", async () => {
    const resolved = backend();
    render(<App />);
    const icon = await screen.findByRole("button", { name: /重试没有完成的图/ });
    fireEvent.contextMenu(icon, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "查看这些图" }));
    await filtered(resolved);
  });

  it("设置 › 自动标签里点“查看”：关掉设置，回到图片墙筛出这些图", async () => {
    const resolved = backend();
    render(<App />);
    const icon = await screen.findByRole("button", { name: /重试没有完成的图/ });
    fireEvent.contextMenu(icon, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "自动标签设置" }));
    const row = await screen.findByRole("listitem", { name: "状态" });
    fireEvent.click(await within(row).findByRole("button", { name: "查看" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "状态" })).toBeNull());
    await filtered(resolved);
  });
});
