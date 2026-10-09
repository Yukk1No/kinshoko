// T20 r10: after a content restore registered new providers in a blank environment, the workspace
// sidebar listed them but "当前资料库" still offered only "尚未打开" until 刷新登记 was clicked.
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { LibraryPicker } from "./LibraryPicker";

const restored = { id: "R1", name: "同名资料库（恢复）", root: "D:\\synthetic-t20\\恢复\\A" };
let registered: { library: typeof restored; unavailable: string | null }[];

beforeEach(() => {
  registered = [];
  mockIPC((cmd) => {
    if (cmd === "plugin:library|registered_libraries") return structuredClone(registered);
    return null;
  }, { shouldMockEvents: true });
});
afterEach(async () => { cleanup(); await act(async () => {}); clearMocks(); });

const options = () => [...screen.getByRole<HTMLSelectElement>("combobox", { name: "当前资料库" }).options].map((o) => o.value);

it("其他入口登记的新资料库随工作区变化出现在当前资料库选项中", async () => {
  render(<LibraryPicker current={null} onChanged={() => {}} onCreate={() => {}} />);
  await act(async () => {});
  expect(options()).toEqual([""]);

  registered = [{ library: restored, unavailable: null }];
  await act(async () => { await emit("workspace-changed", { revision: "r2", libraries: structuredClone(registered) }); });
  await act(async () => {});
  expect(options()).toEqual(["", "R1"]);
});
