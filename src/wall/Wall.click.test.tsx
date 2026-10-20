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

function Harness({ initial = [], onSelection, onOpen, onAside }: {
  initial?: string[]; onSelection?: (ids: string[]) => void; onOpen?: (id: string) => void; onAside?: () => void;
}) {
  const [selected, setSelected] = useState(new Set(initial));
  return <>
    <Wall libraryId="L1" scope={{ kind: "all" }} reloadKey={0} selected={selected}
      onSelectionChange={(next) => { onSelection?.([...next]); setSelected(next); }}
      onOpenImage={(card) => onOpen?.(card.id)} viewerOpen={false} />
    {/* 正在展开的详情侧栏：第二下可能落在这里。 */}
    <aside className="inspector"><button type="button" onClick={onAside}>收起详情</button></aside>
  </>;
}
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
/** 时钟：performance.now 读这里。 */
let clock = 0;
beforeEach(() => { clock = 10_000; vi.spyOn(performance, "now").mockImplementation(() => clock); });
afterEach(() => { vi.restoreAllMocks(); });
/** 一次完整的鼠标按下与松开，按浏览器的顺序派发；detail 是浏览器自己数的连击次数。 */
function press(target: Element, { x = 50, y = 50, detail = 1, ...keys }: { x?: number; y?: number; detail?: number; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const at = { clientX: x, clientY: y, button: 0, ...keys };
  fireEvent.pointerDown(target, at);
  fireEvent.mouseDown(target, { ...at, detail });
  fireEvent.pointerUp(target, at);
  fireEvent.mouseUp(target, { ...at, detail });
  fireEvent.click(target, { ...at, detail });
  if (detail === 2) fireEvent.doubleClick(target, { ...at, detail });
}

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
  press(card("3"));
  clock += 200;
  press(card("3"), { detail: 2 });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("3");
});

it("单击未选中的图只选中它；再单击它（不论隔多久）就打开查看器", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  press(card("2"));
  expect(onSelection).toHaveBeenLastCalledWith(["2"]);
  expect(onOpen).not.toHaveBeenCalled();
  clock += 60_000;
  press(card("2"));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("2");
  expect(onSelection).toHaveBeenCalledTimes(1);
});

it("多选后不按修饰键单击其中一张：选择收缩为这一张，不打开查看器", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness initial={["1", "2", "3"]} onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  press(card("2"));
  expect(onSelection).toHaveBeenLastCalledWith(["2"]);
  expect(onOpen).not.toHaveBeenCalled();
});

it("双击的第二下落在别的卡片上（重排挪走了第一张）：打开第一下的图，不改选择", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  press(card("5"), { x: 300, y: 40 });
  expect(onSelection).toHaveBeenLastCalledWith(["5"]);
  clock += 300;
  press(card("2"), { x: 301, y: 41, detail: 2 });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("5");
  expect(onSelection).toHaveBeenCalledTimes(1);
  expect(card("2").getAttribute("aria-selected")).toBe("false");
});

it("双击的第二下落在正在展开的详情侧栏上：打开第一下的图，侧栏上的按钮不响应", async () => {
  const onOpen = vi.fn();
  const onAside = vi.fn();
  render(<Harness onOpen={onOpen} onAside={onAside} />);
  await screen.findAllByRole("img");
  press(card("5"), { x: 900, y: 40 });
  clock += 450;
  press(screen.getByRole("button", { name: "收起详情" }), { x: 900, y: 40, detail: 2 });
  expect(onOpen).toHaveBeenCalledWith("5");
  expect(onAside).not.toHaveBeenCalled();
  // 第二下之后的按下照常。
  clock += 2000;
  press(screen.getByRole("button", { name: "收起详情" }), { x: 900, y: 40 });
  expect(onAside).toHaveBeenCalledTimes(1);
});

it("超过双击间隔或离开判定范围的第二下是普通单击", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  press(card("5"), { x: 300, y: 40 });
  clock += 501;
  press(card("2"), { x: 300, y: 40 });
  expect(onSelection).toHaveBeenLastCalledWith(["2"]);
  clock += 100;
  press(card("4"), { x: 303, y: 40 });
  expect(onSelection).toHaveBeenLastCalledWith(["4"]);
  expect(onOpen).not.toHaveBeenCalled();
});

it("按着 Ctrl 的第二下不算双击，照常增减选择", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("img");
  press(card("1"));
  clock += 100;
  press(card("3"), { ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["1", "3"]);
  expect(onOpen).not.toHaveBeenCalled();
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
