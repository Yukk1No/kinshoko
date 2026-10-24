// 窄窗口里侧栏与详情面板一起让位，主区不低于 300px。
import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fitPanes, isNarrow, useFloatEscape, usePaneFold } from "./paneFit";

it("放得下时两边都不变", () => {
  expect(fitPanes(968, 320, true)).toEqual({ sidebar: 256, inspector: 320 });
});

it("放不下时按各自还能让的宽度配比：侧栏能让 56，详情能让 40", () => {
  // 窗口 900 − 栏 56 = 844；缺 256 + 320 + 300 − 844 = 32，按 56 : 40 分摊。
  expect(fitPanes(844, 320, true)).toEqual({ sidebar: 237, inspector: 307 });
});

it("详情拖得更宽时，它让得更多", () => {
  // 缺 256 + 440 + 300 − 944 = 52，按 56 : 160 分摊。
  expect(fitPanes(944, 440, true)).toEqual({ sidebar: 243, inspector: 401 });
});

it("两边都到最窄时主区正好 300", () => {
  expect(isNarrow(780, 320)).toBe(false);
  expect(fitPanes(780, 320, true)).toEqual({ sidebar: 200, inspector: 280 });
});

it("两边都到最窄还不够：侧栏收起，详情回到原宽度", () => {
  expect(isNarrow(764, 320)).toBe(true);
  expect(fitPanes(764, 320, false)).toEqual({ sidebar: 0, inspector: 320 });
});

it("最小窗口：侧栏收起，详情收到放得下主区 300 为止，但不低于 280", () => {
  expect(fitPanes(584, 320, false)).toEqual({ sidebar: 0, inspector: 284 });
  expect(fitPanes(500, 320, false)).toEqual({ sidebar: 0, inspector: 280 });
});

it("详情关着时只看侧栏", () => {
  expect(isNarrow(500, 0)).toBe(false);
  expect(isNarrow(499, 0)).toBe(true);
  expect(fitPanes(520, 0, true)).toEqual({ sidebar: 220, inspector: 0 });
});

it("还没排版（宽度为 0）时不动", () => {
  expect(isNarrow(0, 320)).toBe(false);
  expect(fitPanes(0, 320, true)).toEqual({ sidebar: 256, inspector: 320 });
});

describe("usePaneFold", () => {
  const fold = (body: number, inspector: number, paneOpen: boolean) => {
    const onPaneOpen = vi.fn();
    const view = renderHook((p: { body: number; inspector: number; paneOpen: boolean }) => usePaneFold({ ...p, onPaneOpen }),
      { initialProps: { body, inspector, paneOpen } });
    return { view, onPaneOpen };
  };

  it("变窄时收起侧栏，变宽后回到原来开着", () => {
    const { view, onPaneOpen } = fold(844, 320, true);
    expect(view.result.current).toEqual({ sidebar: 237, floating: false });
    view.rerender({ body: 708, inspector: 320, paneOpen: true });
    expect(onPaneOpen).toHaveBeenLastCalledWith(false);
    view.rerender({ body: 708, inspector: 320, paneOpen: false });
    expect(view.result.current).toEqual({ sidebar: 0, floating: false });
    view.rerender({ body: 900, inspector: 320, paneOpen: false });
    expect(onPaneOpen).toHaveBeenLastCalledWith(true);
  });

  it("窄时点开侧栏就浮起来", () => {
    const { view } = fold(708, 320, false);
    view.rerender({ body: 708, inspector: 320, paneOpen: true });
    expect(view.result.current.floating).toBe(true);
  });

  it("原本就收着的侧栏，变宽后也不自己打开", () => {
    const { view, onPaneOpen } = fold(900, 320, false);
    view.rerender({ body: 708, inspector: 320, paneOpen: false });
    view.rerender({ body: 900, inspector: 320, paneOpen: false });
    expect(onPaneOpen).not.toHaveBeenCalled();
  });
});

describe("useFloatEscape", () => {
  it("焦点不在侧栏里时，Esc 也收回浮起的侧栏", () => {
    const onClose = vi.fn();
    const view = renderHook(({ floating }) => useFloatEscape(floating, onClose), { initialProps: { floating: true } });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender({ floating: false });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("里面的弹出层已经用掉的 Esc 不收回侧栏", () => {
    const onClose = vi.fn();
    renderHook(() => useFloatEscape(true, onClose));
    const consume = (e: KeyboardEvent) => e.preventDefault();
    document.body.addEventListener("keydown", consume);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.body.removeEventListener("keydown", consume);
    expect(onClose).not.toHaveBeenCalled();
  });
});
