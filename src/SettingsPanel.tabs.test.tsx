import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backend, resetSettingsTest, tab } from "./SettingsPanel.fixtures";
import { SettingsPanel } from "./SettingsPanel";
import { setMedia } from "./test/platform";
import { cssRule } from "./ui/cssRule";
import settingsCss from "./ui/settings.css?raw";

// jsdom 不排版：每个 tab 给一个按顺序排列的矩形，指示读到的就是它在列表里的位置。
const TAB_HEIGHT = 36;
const tabTop = (el: Element) => [...el.parentElement!.querySelectorAll('[role="tab"]')].indexOf(el) * TAB_HEIGHT;
const rectAt = (top: number) => ({ top, left: 0, width: 176, height: 34 }) as DOMRect;

const indicator = () => document.querySelector<HTMLElement>(".k-set-tab-indicator")!;
const indicatorTop = () => indicator().style.getPropertyValue("--active-tab-top");

beforeEach(() => {
  backend();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("role") === "tab" ? 176 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("role") === "tab" ? 34 : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rectAt(this.getAttribute("role") === "tab" ? tabTop(this) : 0);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetSettingsTest();
});

describe("设置页 tab（#454）", () => {
  it("方向键切换时，选中、焦点与底板都在同一个 tab 上", async () => {
    render(<SettingsPanel initialTab="general" />);
    const general = await screen.findByRole("tab", { name: "通用" });
    await waitFor(() => expect(indicatorTop()).toBe("0px"));

    act(() => general.focus());
    fireEvent.keyDown(general, { key: "ArrowDown" });
    const keys = screen.getByRole("tab", { name: "快捷键" });
    await waitFor(() => expect(document.activeElement).toBe(keys));
    expect(keys.getAttribute("aria-selected")).toBe("true");
    expect(indicatorTop()).toBe(`${tabTop(keys)}px`);
    screen.getByRole("heading", { name: "快捷键", level: 3 });

    fireEvent.keyDown(keys, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(general));
    expect(general.getAttribute("aria-selected")).toBe("true");
    expect(indicatorTop()).toBe("0px");
    screen.getByRole("heading", { name: "通用", level: 3 });
  });

  it("底板跟着点击滑到新 tab，过渡走令牌，tab 自己不再画选中底", async () => {
    render(<SettingsPanel initialTab="general" />);
    await tab("备份");
    expect(indicatorTop()).toBe(`${tabTop(screen.getByRole("tab", { name: "备份" }))}px`);
    expect(cssRule(settingsCss, ".k-set-tab-indicator").transition).toBe("transform var(--t-slow) var(--ease)");
    expect(cssRule(settingsCss, ".k-set-tab[data-active]").background).toBe("transparent");
    expect(cssRule(settingsCss, ".k-set-tab[data-active]")["box-shadow"]).toBeUndefined();
  });

  it("切页时旧页先留着淡出，它不可操作也不被读屏读到，结束后移除", async () => {
    render(<SettingsPanel initialTab="general" />);
    const general = await screen.findByRole("heading", { name: "通用", level: 3 });
    fireEvent.click(screen.getByRole("tab", { name: "备份" }));
    await screen.findByRole("heading", { name: "备份", level: 3 });
    expect(general.isConnected).toBe(true);
    expect(general.closest("[inert]")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "通用", level: 3 })).toBeNull();
    // Tabs.Panel 给未选中的页加 hidden；样式要让它在淡出期间仍然画出来。
    expect(cssRule(settingsCss, ".k-set-page[hidden]").display).toBe("block");
    await waitFor(() => expect(general.isConnected).toBe(false));
  });

  it("减弱动效下旧页立刻换成新页，底板不过渡", async () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    render(<SettingsPanel initialTab="general" />);
    const general = await screen.findByRole("tab", { name: "通用" });
    const heading = screen.getByRole("heading", { name: "通用", level: 3 });
    act(() => general.focus());
    fireEvent.keyDown(general, { key: "ArrowDown" });
    const keys = screen.getByRole("tab", { name: "快捷键" });
    await waitFor(() => expect(document.activeElement).toBe(keys));
    expect(heading.isConnected).toBe(false);
    expect(document.querySelectorAll(".k-set-page")).toHaveLength(1);
    expect(indicatorTop()).toBe(`${tabTop(keys)}px`);
    expect(document.querySelector(".k-dialog-swap-step")).toBeNull();
  });
});
