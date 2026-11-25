import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setMedia } from "../test/platform";
import { pageSwapMs, usePageSwap } from "./usePageSwap";

// 令牌写在 tokens.css 里，jsdom 不读样式表：这里按真实值写上。
beforeEach(() => {
  document.documentElement.style.setProperty("--t-fast", "120ms");
  document.documentElement.style.setProperty("--t-pop", "220ms");
  document.documentElement.style.setProperty("--t-slow", "260ms");
});
afterEach(() => {
  for (const name of ["--t-fast", "--t-pop", "--t-slow"]) document.documentElement.style.removeProperty(name);
  vi.useRealTimers();
  setMedia("(prefers-reduced-motion: reduce)", false);
});

describe("图片页与订阅页之间的过渡", () => {
  it("去订阅页：侧栏先收着、订阅页淡入，过渡完就结束", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ shown }) => usePageSwap(shown), { initialProps: { shown: false } });
    expect(result.current.phase).toBeNull();
    rerender({ shown: true });
    expect(result.current).toMatchObject({ phase: "in", paneHeld: true, subscriptionsLeaving: false });
    act(() => vi.advanceTimersByTime(pageSwapMs()));
    expect(result.current).toMatchObject({ phase: null, paneHeld: false });
  });

  it("回图片页：订阅页留着淡出，侧栏先收一帧再展开", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { result, rerender } = renderHook(({ shown }) => usePageSwap(shown), { initialProps: { shown: true } });
    rerender({ shown: false });
    expect(result.current).toMatchObject({ phase: "out-start", paneHeld: true, subscriptionsLeaving: true });
    act(() => vi.advanceTimersByTime(40));
    expect(result.current).toMatchObject({ phase: "out", paneHeld: false, subscriptionsLeaving: true });
    act(() => vi.advanceTimersByTime(pageSwapMs()));
    expect(result.current.phase).toBeNull();
  });

  it("淡出第一帧后立刻切回订阅页时，内层帧不会再把阶段改回 out", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { result, rerender } = renderHook(({ shown }) => usePageSwap(shown), { initialProps: { shown: true } });
    rerender({ shown: false });
    expect(result.current.phase).toBe("out-start");
    // 外层帧已经跑进、内层帧已经排上；这一刻又切回去，内层帧也必须取消。
    act(() => vi.advanceTimersByTime(16));
    rerender({ shown: true });
    act(() => vi.advanceTimersByTime(32));
    expect(result.current.phase).toBe("in");
  });

  it("过渡时长按动效令牌算", () => {
    expect(pageSwapMs()).toBe(340);
  });

  it("减弱动效时直接换", () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    const { result, rerender } = renderHook(({ shown }) => usePageSwap(shown), { initialProps: { shown: false } });
    rerender({ shown: true });
    expect(result.current.phase).toBeNull();
    rerender({ shown: false });
    expect(result.current.phase).toBeNull();
  });
});
