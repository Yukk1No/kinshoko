// #157：拖动详情面板的左边缘改宽度。280–560，同时不超过窗口一半；双击回到 320；方向键每次一小步。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { InspectorResizer } from "./InspectorResizer";

let resized: { width: number; done: boolean }[];
beforeEach(() => {
  resized = [];
  vi.stubGlobal("innerWidth", 1600);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ initial = 320 }: { initial?: number }) {
  const [width, setWidth] = useState(initial);
  return <InspectorResizer width={width} onResize={(next, done) => { resized.push({ width: next, done }); setWidth(next); }} />;
}

const handle = () => screen.getByRole("separator", { name: "调整详情宽度" });
/** 按住手柄从 x 拖到 to（面板在右边：往左拖变宽）。 */
function drag(from: number, ...to: number[]) {
  fireEvent.pointerDown(handle(), { clientX: from, button: 0, pointerId: 1 });
  for (const x of to) fireEvent.pointerMove(handle(), { clientX: x, pointerId: 1 });
  fireEvent.pointerUp(handle(), { clientX: to.at(-1), pointerId: 1 });
}
const width = () => Number(handle().getAttribute("aria-valuenow"));

it("往左拖变宽、往右拖变窄；拖动中只预览，松手时定下一次", () => {
  render(<Harness />);
  drag(1000, 990, 950, 900);
  expect(width()).toBe(420);
  expect(resized.filter((r) => r.done)).toEqual([{ width: 420, done: true }]);
  expect(resized.slice(0, -1).every((r) => !r.done)).toBe(true);
  drag(1000, 1060);
  expect(width()).toBe(360);
});

it("拖出 280–560 时停在边界上", () => {
  render(<Harness />);
  drag(1000, 200);
  expect(width()).toBe(560);
  drag(1000, 1900);
  expect(width()).toBe(280);
});

it("不超过窗口宽度的一半", () => {
  vi.stubGlobal("innerWidth", 900);
  render(<Harness />);
  drag(800, 100);
  expect(width()).toBe(450);
  expect(handle().getAttribute("aria-valuemax")).toBe("450");
});

it("双击手柄回到 320", () => {
  render(<Harness initial={500} />);
  fireEvent.doubleClick(handle());
  expect(width()).toBe(320);
  expect(resized.at(-1)).toEqual({ width: 320, done: true });
});

it("手柄能聚焦，左右方向键每次调整一小步", () => {
  render(<Harness />);
  handle().focus();
  expect(document.activeElement).toBe(handle());
  fireEvent.keyDown(handle(), { key: "ArrowLeft" });
  expect(width()).toBe(336);
  fireEvent.keyDown(handle(), { key: "ArrowRight" });
  fireEvent.keyDown(handle(), { key: "ArrowRight" });
  expect(width()).toBe(304);
  expect(resized.every((r) => r.done)).toBe(true);
});
