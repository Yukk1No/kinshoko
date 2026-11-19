// 左栏的动画（#608）：图库托盘展开、收起；选中的纸片在整个左栏里滑动。
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { animations, setMedia } from "../test/platform";
import { WorkspacePane } from "./WorkspacePane";
import { arrow, inA, loaded, props, section } from "./WorkspacePane.fixtures";

afterEach(() => {
  vi.useRealTimers();
  setMedia("(prefers-reduced-motion: reduce)", false);
});

const tray = (id: string) => section(id).querySelector<HTMLElement>(".lib-fold");

it("收起图库：托盘先留着、标成正在收起且不可操作，收起动画放完再拿掉", async () => {
  await loaded();
  fireEvent.click(arrow("A"));
  expect(tray("A")).toBeTruthy();
  vi.useFakeTimers();
  fireEvent.click(arrow("A"));
  expect(tray("A")?.hasAttribute("data-closing")).toBe(true);
  expect(tray("A")?.hasAttribute("inert")).toBe(true);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(tray("A")).toBeNull();
});

it("减少动态效果时收起直接拿掉", async () => {
  setMedia("(prefers-reduced-motion: reduce)", true);
  await loaded();
  fireEvent.click(arrow("A"));
  fireEvent.click(arrow("A"));
  expect(tray("A")).toBeNull();
});

it("从“全部图片”点到某个图库里的文件夹，纸片滑过去（隔着图库也滑）", async () => {
  const view = await loaded();
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "unassigned" })} />);
  const row = within(section("A")).getByRole("button", { name: /人物（/ });
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "folder", id: "A-root" })} />);
  const slides = animations(row).filter((a) => a.effect.getTiming().pseudoElement === "::before");
  expect(slides).toHaveLength(1);
});
