import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { Wall } from "./Wall";

// 卡片的鼠标与键盘交互（#146）：单击选中，双击或 Enter 打开查看器。
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

function Harness({ initial = [], onSelection, onOpen }: {
  initial?: string[]; onSelection?: (ids: string[]) => void; onOpen?: (id: string) => void;
}) {
  const [selected, setSelected] = useState(new Set(initial));
  return <Wall libraryId="L1" scope={{ kind: "all" }} reloadKey={0} selected={selected}
    onSelectionChange={(next) => { onSelection?.([...next]); setSelected(next); }}
    onOpenImage={(card) => onOpen?.(card.id)} viewerOpen={false} />;
}
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;

it("单击卡片：选择替换为只有这一张，不打开查看器", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness initial={["1", "2"]} onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  fireEvent.click(card("4"));
  expect(onSelection).toHaveBeenLastCalledWith(["4"]);
  expect(onOpen).not.toHaveBeenCalled();
  expect(card("4").getAttribute("aria-selected")).toBe("true");
  expect(card("1").getAttribute("aria-selected")).toBe("false");
});

it("双击卡片：打开查看器一次，打开的是这张", async () => {
  const onOpen = vi.fn();
  render(<Harness onOpen={onOpen} />);
  await screen.findAllByRole("img");
  // 浏览器里双击先后派发两次 click 和一次 dblclick。
  fireEvent.click(card("3"), { detail: 1 });
  fireEvent.click(card("3"), { detail: 2 });
  fireEvent.doubleClick(card("3"), { detail: 2 });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("3");
});

it("Enter 打开查看器，空格切换选中", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness initial={["1"]} onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  fireEvent.keyDown(card("2"), { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("2");
  fireEvent.keyDown(card("4"), { key: " " });
  expect(onSelection).toHaveBeenLastCalledWith(["4"]);
  fireEvent.keyDown(card("5"), { key: " ", ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["4", "5"]);
  fireEvent.keyDown(card("5"), { key: " ", ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["4"]);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("Ctrl 单击切换多选，Shift 单击选到范围，都不打开查看器", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  fireEvent.click(card("1"));
  fireEvent.click(card("3"), { ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["1", "3"]);
  fireEvent.click(card("1"), { ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["3"]);
  fireEvent.click(card("5"), { shiftKey: true });
  // 范围起点是最后一次单击或 Ctrl 单击的那张（1）。
  expect(onSelection).toHaveBeenLastCalledWith(["1", "2", "3", "4", "5"]);
  expect(onOpen).not.toHaveBeenCalled();
});

it("安全模式下单击被遮蔽的卡片：只选中，不揭开遮蔽，不打开查看器", async () => {
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return { cards: [{ id: "x", width: 100, height: 100, thumbnail: "L1/x/256", adult: true }], total: 1, nextCursor: null };
  });
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  expect(card("x").dataset.veiled).toBe("true");
  fireEvent.click(card("x"));
  expect(onSelection).toHaveBeenLastCalledWith(["x"]);
  expect(onOpen).not.toHaveBeenCalled();
  expect(card("x").dataset.veiled).toBe("true");
});

it("单击图片墙空白处：清空选择；按着 Ctrl 或 Shift 时不清空", async () => {
  const onSelection = vi.fn();
  render(<Harness initial={["1", "2"]} onSelection={onSelection} />);
  await screen.findAllByRole("img");
  fireEvent.click(document.querySelector(".wall-canvas")!, { ctrlKey: true });
  fireEvent.click(document.querySelector(".wall-canvas")!, { shiftKey: true });
  expect(onSelection).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".wall-canvas")!);
  expect(onSelection).toHaveBeenLastCalledWith([]);
  expect(card("1").getAttribute("aria-selected")).toBe("false");
});
