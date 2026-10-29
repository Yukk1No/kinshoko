import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseStartup, resetStartupGate, startupThumbnailShown, startupWallPage } from "../startupGate";
import { StartupSplash } from "./StartupSplash";

let reduced = true;
vi.mock("../ui/reducedMotion", () => ({ useReducedMotion: () => reduced }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(0);
  resetStartupGate();
  reduced = true;
});
afterEach(() => {
  cleanup();
  resetStartupGate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 一帧一帧地走：每帧之间让 React 提交，像浏览器那样。 */
const frames = (ms: number) => { for (let t = 0; t < ms; t += 16) act(() => vi.advanceTimersByTime(16)); };
const bar = () => document.querySelector<HTMLElement>(".startup-bar")!;

describe("StartupSplash (#338)", () => {
  it("covers the window with the logo and a bar, no words, until the first screen is in", () => {
    render(<StartupSplash />);
    const splash = screen.getByRole("status", { name: "正在打开图库" });
    expect(splash.getAttribute("aria-busy")).toBe("true");
    expect(splash.textContent).toBe("");
    expect(splash.querySelector(".startup-logo")).toBeTruthy();
    act(() => { startupWallPage(2); startupThumbnailShown(); });
    expect(Number(bar().dataset.progress)).toBe(75);
    expect(screen.getByRole("status", { name: "正在打开图库" })).toBeTruthy();
  });

  it("fades out with reduced motion once released, leaving the window to the app", () => {
    render(<StartupSplash />);
    act(() => releaseStartup());
    const splash = screen.getByRole("status", { name: "正在打开图库" });
    expect(splash.dataset.phase).toBe("leaving");
    expect(splash.dataset.reduced).toBe("true");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status", { name: "正在打开图库" })).toBeNull();
  });

  it("gets out of the way after five seconds even if thumbnails never arrive", () => {
    render(<StartupSplash />);
    act(() => startupWallPage(500));
    act(() => vi.advanceTimersByTime(5000));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status", { name: "正在打开图库" })).toBeNull();
  });

  it("opens a star-shaped hole that grows until the splash is gone", () => {
    reduced = false;
    // jsdom 不排版：给窗口与字标一个尺寸，开口才有位置。
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 1280, height: 800 }));
    render(<StartupSplash />);
    act(() => releaseStartup());
    const splash = screen.getByRole("status", { name: "正在打开图库" });
    // 先等主线程连续几帧顺畅，再开始退场。
    expect(splash.dataset.phase).toBe("settling");
    frames(600);
    expect(splash.dataset.phase).toBe("leaving");
    expect(splash.style.clipPath).toMatch(/^path\(evenodd, "M0 0H/);
    frames(1200);
    expect(screen.queryByRole("status", { name: "正在打开图库" })).toBeNull();
  });
});
