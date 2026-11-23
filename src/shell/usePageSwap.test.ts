import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setMedia } from "../test/platform";
import { PAGE_SWAP_MS, usePageSwap } from "./usePageSwap";

afterEach(() => {
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
    act(() => vi.advanceTimersByTime(PAGE_SWAP_MS));
    expect(result.current).toMatchObject({ phase: null, paneHeld: false });
  });

  it("回图片页：订阅页留着淡出，侧栏先收一帧再展开", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { result, rerender } = renderHook(({ shown }) => usePageSwap(shown), { initialProps: { shown: true } });
    rerender({ shown: false });
    expect(result.current).toMatchObject({ phase: "out-start", paneHeld: true, subscriptionsLeaving: true });
    act(() => vi.advanceTimersByTime(40));
    expect(result.current).toMatchObject({ phase: "out", paneHeld: false, subscriptionsLeaving: true });
    act(() => vi.advanceTimersByTime(PAGE_SWAP_MS));
    expect(result.current.phase).toBeNull();
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
