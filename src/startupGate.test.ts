import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_SCREEN, STARTUP_TIMEOUT_MS, releaseStartup, resetStartupGate, startupLibraryOpened, startupThumbnailShown,
  startupWallMounted, startupWallPage, useStartupGate,
} from "./startupGate";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(0);
  resetStartupGate();
});
afterEach(() => {
  resetStartupGate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const shown = (n: number) => { for (let i = 0; i < n; i++) startupThumbnailShown(); };

describe("startup gate (#338)", () => {
  it("waits for the first screen of thumbnails, advancing as they arrive", () => {
    const { result } = renderHook(() => useStartupGate());
    const start = result.current.progress;
    act(() => startupLibraryOpened());
    expect(result.current.progress).toBeGreaterThan(start);
    act(() => startupWallPage(500));
    act(() => shown(FIRST_SCREEN - 1));
    expect(result.current.released).toBe(false);
    expect(result.current.progress).toBeLessThan(1);
    act(() => shown(1));
    expect(result.current).toEqual({ progress: 1, released: true });
  });

  it("waits only for the cards a short first page has", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => startupWallPage(3));
    act(() => shown(3));
    expect(result.current.released).toBe(true);
  });

  it("waits only for the cards the wall actually mounted when fewer than the first screen fit", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => { startupWallPage(500); startupWallMounted(12); });
    act(() => shown(11));
    expect(result.current.released).toBe(false);
    act(() => shown(1));
    expect(result.current.released).toBe(true);
  });

  it("follows the latest mounted count while the layout settles", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => { startupWallPage(500); startupWallMounted(3); startupWallMounted(16); });
    act(() => shown(3));
    expect(result.current.released).toBe(false);
    act(() => shown(13));
    expect(result.current.released).toBe(true);
  });

  it("lets an empty wall through at once", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => startupWallPage(0));
    expect(result.current.released).toBe(true);
  });

  it("counts thumbnails that arrived before the page size was known", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => shown(2));
    act(() => startupWallPage(2));
    expect(result.current.released).toBe(true);
  });

  it("only the first page sets the count; later pages do not raise it", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => startupWallPage(4));
    act(() => startupWallPage(500));
    act(() => shown(4));
    expect(result.current.released).toBe(true);
  });

  it("gives up waiting after the timeout, measured from page load", () => {
    vi.mocked(performance.now).mockReturnValue(1200);
    const { result } = renderHook(() => useStartupGate());
    act(() => startupWallPage(500));
    act(() => vi.advanceTimersByTime(STARTUP_TIMEOUT_MS - 1200 - 1));
    expect(result.current.released).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.released).toBe(true);
  });

  it("stays released once released", () => {
    const { result } = renderHook(() => useStartupGate());
    act(() => releaseStartup());
    act(() => { startupLibraryOpened(); startupWallPage(500); });
    expect(result.current).toEqual({ progress: 1, released: true });
  });
});
