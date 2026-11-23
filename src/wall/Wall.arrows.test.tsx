import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { Wall } from "./Wall";
import { workspacePage } from "../test/workspacePage";
import { fakeBackend } from "../test/backend";

// 方向键在图片墙上按看到的位置移到相邻的图：焦点与选择一起走，移到的图滚进视口。
let count = 6;
let height = (_i: number) => 100;
beforeEach(() => {
  localStorage.clear();
  count = 6;
  height = () => 100;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  fakeBackend({
    workspace_browse: () =>
      workspacePage(Array.from({ length: count }, (_, i) => ({ id: String(i), width: 100, height: height(i) }))),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness({ onSelection }: { onSelection?: (ids: string[]) => void }) {
  const [selected, setSelected] = useState(new Set<string>());
  return (
    <Wall
      workspaceScope={{ kind: "all" }}
      scope={{ kind: "all" }}
      reloadKey={0}
      selected={selected}
      onSelectionChange={(next) => {
        onSelection?.([...next].sort());
        setSelected(next);
      }}
      onOpenImage={() => {}}
      viewerOpen={false}
    />
  );
}
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.id;
/** 在焦点所在的卡片上按一个键；返回浏览器的默认动作（滚动）是否照常。 */
const key = (k: string, mods: { shiftKey?: boolean } = {}) =>
  fireEvent.keyDown(document.activeElement!, { key: k, ...mods });

it("方向键按看到的位置移到相邻的图，焦点与选择一起走，不滚动整面墙", async () => {
  // 1000 宽、目标 240：4 列。0 1 2 3 是第一行，4 5 在 0 1 下面。
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("img");
  card("0").focus();
  expect(key("ArrowRight")).toBe(false);
  expect(focused()).toBe("1");
  expect(onSelection).toHaveBeenLastCalledWith(["1"]);
  expect(card("1").getAttribute("aria-selected")).toBe("true");
  key("ArrowDown");
  expect(focused()).toBe("5");
  key("ArrowLeft");
  expect(focused()).toBe("4");
  key("ArrowUp");
  expect(focused()).toBe("0");
  expect(onSelection).toHaveBeenLastCalledWith(["0"]);
});

it("到了边上再按：焦点不动，也不滚动", async () => {
  render(<Harness />);
  await screen.findAllByRole("img");
  card("0").focus();
  expect(key("ArrowLeft")).toBe(false);
  expect(key("ArrowUp")).toBe(false);
  expect(focused()).toBe("0");
});

it("Shift + 方向键从起点选中一段", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("img");
  fireEvent.click(card("0"));
  card("0").focus();
  key("ArrowRight", { shiftKey: true });
  key("ArrowRight", { shiftKey: true });
  expect(focused()).toBe("2");
  expect(onSelection).toHaveBeenLastCalledWith(["0", "1", "2"]);
});

it("没点过任何图（Tab 过来）时 Shift + 方向键从焦点所在的图选起", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("img");
  card("0").focus();
  key("ArrowRight", { shiftKey: true });
  key("ArrowRight", { shiftKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["0", "1", "2"]);
});

it("移到视口外的图：滚进视口再接过焦点", async () => {
  count = 400;
  height = (i) => 100 + (i % 5) * 40;
  render(<Harness />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  card("0").focus();
  for (let step = 0; step < 12; step++) {
    key("ArrowDown");
    const node = document.activeElement as HTMLElement;
    expect(node.classList.contains("card")).toBe(true);
    const top = parseFloat(node.style.top);
    expect(top).toBeGreaterThanOrEqual(wall.scrollTop);
    expect(top + parseFloat(node.style.height)).toBeLessThanOrEqual(wall.scrollTop + 800);
  }
  expect(wall.scrollTop).toBeGreaterThan(1000);
});
