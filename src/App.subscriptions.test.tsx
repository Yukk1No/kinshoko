import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { SubscriptionStatus } from "./bindings/SubscriptionStatus";
import { App } from "./App";
import { backend, library } from "./App.fixtures";
import { status } from "./subscriptions/subscriptions.fixtures";

const entry = () => screen.queryByRole("button", { name: "订阅" });
const push = (next: SubscriptionStatus) => act(() => emit("subscription-status", next));

/** 订阅功能（#368）：`subscription_status` 回什么，主窗口就按什么显示；没有订阅功能时命令 reject。 */
let openRequest: unknown = null;

function withSubscriptions(initial: SubscriptionStatus | "unavailable") {
  openRequest = null;
  backend(library, undefined, (cmd) => {
    if (cmd === "plugin:desktop|take_open_request") { const next = openRequest; openRequest = null; return next; }
    if (cmd === "subscription_status") return initial === "unavailable" ? Promise.reject("unavailable") : initial;
    if (cmd === "subscriptions" || cmd === "subscription_recent") return [];
    return undefined;
  });
}

describe("订阅入口", () => {
  it("这一版没有订阅功能时图标轨不显示入口，Ctrl+4 也不打开", async () => {
    withSubscriptions("unavailable");
    render(<App />);
    await screen.findByRole("button", { name: "参考组" });
    expect(entry()).toBeNull();
    fireEvent.keyDown(window, { key: "4", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "订阅" })).toBeNull();
  });

  it("开着时显示入口与新图数，超过 99 写 99+", async () => {
    withSubscriptions(status({ newCount: 12 }));
    render(<App />);
    await waitFor(() => expect(entry()?.querySelector(".rail-badge")?.textContent).toBe("12"));
    await push(status({ newCount: 120 }));
    expect(entry()?.querySelector(".rail-badge")?.textContent).toBe("99+");
    await push(status({ newCount: 0 }));
    expect(entry()?.querySelector(".rail-badge")).toBeNull();
  });

  it("关掉订阅功能后入口隐藏，开着的订阅页回到图片与文件夹", async () => {
    withSubscriptions(status());
    render(<App />);
    await waitFor(() => expect(entry()).toBeTruthy());
    fireEvent.click(entry()!);
    expect(await screen.findByRole("complementary", { name: "订阅" })).toBeTruthy();
    await push(status({ enabled: false }));
    expect(entry()).toBeNull();
    expect(screen.queryByRole("complementary", { name: "订阅" })).toBeNull();
    expect(screen.getByRole("button", { name: "图片与文件夹" }).getAttribute("aria-current")).toBe("page");
    fireEvent.keyDown(window, { key: "4", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "订阅" })).toBeNull();
    await push(status());
    fireEvent.keyDown(window, { key: "4", ctrlKey: true });
    expect(await screen.findByRole("complementary", { name: "订阅" })).toBeTruthy();
  });

  it("开着订阅页时从钉图“在 Kinshoko 中打开”参考图，回到图片与文件夹", async () => {
    withSubscriptions(status());
    render(<App />);
    await waitFor(() => expect(entry()).toBeTruthy());
    fireEvent.click(entry()!);
    expect(await screen.findByRole("complementary", { name: "订阅" })).toBeTruthy();
    openRequest = { kind: "reference", libraryId: "L1", imageId: "a" };
    await act(() => emit("open-in-kinshoko"));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "订阅" })).toBeNull());
    expect(screen.getByRole("button", { name: "图片与文件夹" }).getAttribute("aria-current")).toBe("page");
  });
});
