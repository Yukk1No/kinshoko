import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { createRef, useState } from "react";
import { Wall, type WallHandle } from "./Wall";
import type { WallMenuTarget } from "./WallMenu";
import { MenuItem } from "../ui/Menu";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return { cards: Array.from({ length: 6 }, (_, i) => ({ id: String(i), width: 100, height: 100, thumbnail: `L1/${i}/256`, adult: false })), total: 6, nextCursor: null };
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

const describe = (target: WallMenuTarget) => target.kind === "cards" ? `卡片 ${target.cards.map((c) => c.id).join(",")}` : "空白处";

function Harness({ initial = [], onCommand, onSelection, handle, onPaste, viewerOpen = false }: {
  initial?: string[]; onCommand?: (...args: unknown[]) => void; onSelection?: (ids: string[]) => void; handle?: React.Ref<WallHandle>;
  onPaste?: () => void; viewerOpen?: boolean;
}) {
  const [selected, setSelected] = useState(new Set(initial));
  return <Wall ref={handle} libraryId="L1" scope={{ kind: "all" }} reloadKey={0} selected={selected}
    onSelectionChange={(next) => { onSelection?.([...next]); setSelected(next); }} onOpenImage={() => {}} viewerOpen={viewerOpen}
    menu={(target) => <MenuItem>{describe(target)}</MenuItem>} onCardCommand={onCommand} onPaste={onPaste} />;
}
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;

it("右键未选中的卡片：选择改为只有这一张，菜单作用于它", async () => {
  const onSelection = vi.fn();
  render(<Harness initial={["1", "2"]} onSelection={onSelection} />);
  await screen.findAllByRole("img");
  fireEvent.contextMenu(card("4"), { clientX: 30, clientY: 40 });
  expect(onSelection).toHaveBeenLastCalledWith(["4"]);
  expect(await screen.findByRole("menuitem", { name: "卡片 4" })).toBeTruthy();
  expect(card("4").getAttribute("aria-selected")).toBe("true");
  expect(card("1").getAttribute("aria-selected")).toBe("false");
});

it("右键已选中的卡片：选择不变，菜单作用于整组（按图片墙顺序）", async () => {
  const onSelection = vi.fn();
  render(<Harness initial={["3", "1", "2"]} onSelection={onSelection} />);
  await screen.findAllByRole("img");
  fireEvent.contextMenu(card("2"));
  expect(onSelection).not.toHaveBeenCalled();
  expect(await screen.findByRole("menuitem", { name: "卡片 1,2,3" })).toBeTruthy();
});

it("右键空白处：空白处菜单，选择不变", async () => {
  const onSelection = vi.fn();
  render(<Harness initial={["1"]} onSelection={onSelection} />);
  await screen.findAllByRole("img");
  fireEvent.contextMenu(document.querySelector(".wall-canvas")!);
  expect(await screen.findByRole("menuitem", { name: "空白处" })).toBeTruthy();
  expect(onSelection).not.toHaveBeenCalled();
});

it.each([["菜单键", { key: "ContextMenu" }], ["Shift+F10", { key: "F10", shiftKey: true }]])("%s 在聚焦的卡片上打开同一菜单", async (_, keys) => {
  render(<Harness />);
  await screen.findAllByRole("img");
  card("5").focus();
  fireEvent.keyDown(card("5"), keys);
  expect(await screen.findByRole("menuitem", { name: "卡片 5" })).toBeTruthy();
});

it("快捷键：P 钉住、F1 框选、Del 移到回收站，按右键的同一选择规则作用", async () => {
  const onCommand = vi.fn();
  render(<Harness initial={["1", "2"]} onCommand={onCommand} />);
  await screen.findAllByRole("img");
  fireEvent.keyDown(card("1"), { key: "p" });
  expect(onCommand).toHaveBeenLastCalledWith("pin", [expect.objectContaining({ id: "1" }), expect.objectContaining({ id: "2" })], expect.any(Object));
  fireEvent.keyDown(card("4"), { key: "Delete" });
  expect(onCommand).toHaveBeenLastCalledWith("trash", [expect.objectContaining({ id: "4" })], expect.any(Object));
  fireEvent.keyDown(card("4"), { key: "F1" });
  expect(onCommand).toHaveBeenLastCalledWith("crop", [expect.objectContaining({ id: "4" })], expect.any(Object));
});

it("Ctrl+C 复制：选中单张时作用于它；聚焦未选中的卡片时选择改为这一张（#105）", async () => {
  const onCommand = vi.fn();
  render(<Harness initial={["2"]} onCommand={onCommand} />);
  await screen.findAllByRole("img");
  fireEvent.keyDown(card("2"), { key: "c", ctrlKey: true });
  expect(onCommand).toHaveBeenLastCalledWith("copy", [expect.objectContaining({ id: "2" })], expect.any(Object));
  fireEvent.keyDown(card("4"), { key: "c", ctrlKey: true });
  expect(onCommand).toHaveBeenLastCalledWith("copy", [expect.objectContaining({ id: "4" })], expect.any(Object));
  expect(card("4").getAttribute("aria-selected")).toBe("true");
});

it("Ctrl+C 在多选时交给调用方（由它提示一次只能复制一张）", async () => {
  const onCommand = vi.fn();
  render(<Harness initial={["1", "3"]} onCommand={onCommand} />);
  await screen.findAllByRole("img");
  fireEvent.keyDown(card("1"), { key: "C", ctrlKey: true });
  expect(onCommand).toHaveBeenLastCalledWith("copy", [expect.objectContaining({ id: "1" }), expect.objectContaining({ id: "3" })], expect.any(Object));
});

it("Ctrl+V 从剪贴板导入：主窗口里不在输入框时都可用，查看器打开时不响应（#105）", async () => {
  const onPaste = vi.fn();
  const { rerender } = render(<><input aria-label="查找" /><Harness onPaste={onPaste} /></>);
  await screen.findAllByRole("img");
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  expect(onPaste).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(card("1"), { key: "v", ctrlKey: true });
  expect(onPaste).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "查找" }), { key: "v", ctrlKey: true });
  expect(onPaste).toHaveBeenCalledTimes(2);
  rerender(<><input aria-label="查找" /><Harness onPaste={onPaste} viewerOpen /></>);
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  expect(onPaste).toHaveBeenCalledTimes(2);
});

it("Ctrl+A 与 selectAll 选中已读到的全部图", async () => {
  const onSelection = vi.fn();
  const handle = createRef<WallHandle>();
  render(<Harness onSelection={onSelection} handle={handle} />);
  await screen.findAllByRole("img");
  fireEvent.keyDown(card("0"), { key: "a", ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["0", "1", "2", "3", "4", "5"]);
  onSelection.mockClear();
  handle.current!.selectAll();
  expect(onSelection).toHaveBeenLastCalledWith(["0", "1", "2", "3", "4", "5"]);
});
