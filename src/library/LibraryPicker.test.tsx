// T20 r10: after a content restore registered new providers in a blank environment, the workspace
// sidebar listed them but "当前资料库" still offered only "尚未打开" until 刷新登记 was clicked.
// #98: the switch is now the sidebar title menu; 刷新登记 is gone and opening the menu re-reads.
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { LibraryPicker } from "./LibraryPicker";

const restored = { id: "R1", name: "同名资料库（恢复）", root: "D:\\synthetic-t20\\恢复\\A" };
let registered: { library: typeof restored; unavailable: string | null }[];
let reads: number;

beforeEach(() => {
  registered = [];
  reads = 0;
  mockIPC((cmd) => {
    if (cmd === "plugin:library|registered_libraries") { reads += 1; return structuredClone(registered); }
    return null;
  }, { shouldMockEvents: true });
});
afterEach(async () => { cleanup(); await act(async () => {}); clearMocks(); });

const options = () => screen.queryAllByRole("menuitemradio").map((o) => o.textContent);
const openMenu = async () => {
  fireEvent.click(screen.getByRole("button", { name: /^当前图库：/ }));
  await screen.findByRole("menu");
  await act(async () => {});
};

it("其他入口登记的新资料库随工作区变化出现在图库切换菜单中", async () => {
  render(<LibraryPicker current={null} onChanged={() => {}} onCreate={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: /^当前图库：/ }).getAttribute("aria-label")).toBe("当前图库：尚未打开图库");
  await openMenu();
  expect(options()).toEqual([]);
  expect(screen.getByText("还没有打开的图库")).toBeTruthy();

  registered = [{ library: restored, unavailable: null }];
  await act(async () => { await emit("workspace-changed", { revision: "r2", libraries: structuredClone(registered) }); });
  await act(async () => {});
  expect(options()).toEqual(["同名资料库（恢复）"]);
});

it("打开菜单时重新读取登记（代替原“刷新登记”按钮）", async () => {
  render(<LibraryPicker current={null} onChanged={() => {}} onCreate={() => {}} />);
  await act(async () => {});
  const before = reads;
  registered = [{ library: restored, unavailable: "移动盘没插" }];
  await openMenu();
  expect(reads).toBeGreaterThan(before);
  expect(screen.getByRole("menuitemradio", { name: /^同名资料库（恢复）/ }).textContent).toContain("未连接");
});
