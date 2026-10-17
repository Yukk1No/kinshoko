// T20 r10: after a content restore registered new providers in a blank environment, the workspace
// sidebar listed them but "当前资料库" still offered only "尚未打开" until 刷新登记 was clicked.
// #98: the switch moved to the sidebar title menu. #113 (ADR-0008): there is no current library to
// switch any more; the title is “图库” with a ＋ menu, and 管理图库 re-reads the registrations.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { LibraryPicker } from "./LibraryPicker";

const opened = { id: "L1", name: "工作参考", root: "D:\\参考" };
const restored = { id: "R1", name: "同名资料库（恢复）", root: "D:\\synthetic-t20\\恢复\\A" };
let registered: { library: typeof restored; unavailable: string | null }[];
let reads: number;

beforeEach(() => {
  registered = [{ library: opened, unavailable: null }];
  reads = 0;
  mockIPC((cmd) => {
    if (cmd === "plugin:library|registered_libraries") { reads += 1; return structuredClone(registered); }
    return null;
  }, { shouldMockEvents: true });
});
afterEach(async () => { cleanup(); await act(async () => {}); clearMocks(); });

it("侧栏标题是“图库”与一个 ＋ 菜单（打开 / 新建 / 管理），没有图库切换", async () => {
  const create = vi.fn();
  render(<LibraryPicker current={opened} onChanged={() => {}} onCreate={create} />);
  await act(async () => {});
  expect(screen.getByRole("heading", { name: "图库" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^当前图库/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开、新建或管理图库" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["打开图库…", "新建图库…", "管理图库"]);
  expect(within(menu).queryAllByRole("menuitemradio")).toEqual([]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "新建图库…" }));
  expect(create).toHaveBeenCalledTimes(1);
});

it("其他入口登记的新资料库随工作区变化出现在“管理图库”里", async () => {
  render(<LibraryPicker current={opened} onChanged={() => {}} onCreate={() => {}} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "打开、新建或管理图库" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "管理图库" }));
  const dialog = await screen.findByRole("dialog", { name: "管理图库" });
  await act(async () => {});
  expect(within(dialog).queryByText("同名资料库（恢复）")).toBeNull();

  registered = [...registered, { library: restored, unavailable: "移动盘没插" }];
  const before = reads;
  await act(async () => { await emit("workspace-changed", { revision: "r2", libraries: structuredClone(registered) }); });
  await act(async () => {});
  expect(reads).toBeGreaterThan(before);
  expect(within(dialog).getByText("同名资料库（恢复）")).toBeTruthy();
  expect(within(dialog).getByText("移动盘没插")).toBeTruthy();
});
