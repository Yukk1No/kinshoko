import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { i18n } from ".";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SubscriptionSettings } from "../subscriptions/SubscriptionSettings";
import { SubscriptionsPage } from "../subscriptions/SubscriptionsPage";
import { account, list, NOW, recent, status } from "../subscriptions/subscriptions.fixtures";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下订阅页与设置 › 订阅没有中文（#368）。订阅名是画师的数据，不算。
const names = list.map((s) => s.name);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.setItem("kinshoko.subscriptions.firstRunSeen", "1");
  mockWindows("main");
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd === "subscriptions") return list;
    if (cmd === "subscription_recent") return recent;
    return null;
  }, { shouldMockEvents: true });
  await act(async () => { await i18n.changeLanguage("en"); });
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  clearMocks();
});

const page = (s: SubscriptionStatus) => render(<SubscriptionsPage status={s} onStatus={vi.fn()} safe={false} paneOpen onPaneToggle={vi.fn()} onOpenImage={vi.fn()} />);

describe("英文界面：订阅", () => {
  it("订阅页：名单、两段图片墙与各检查状态", async () => {
    for (const s of [status(), status({ checking: true }), status({ backoffUntil: NOW + 3_600_000 }), status({ login: { state: "expired", account } })]) {
      page(s);
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Open in library" })).toHaveLength(5));
      expectNoChinese(document.body, names);
      cleanup();
    }
    page(status());
    expect(await screen.findByText("Synced 10 minutes ago")).toBeTruthy();
    expect(screen.getByRole("button", { name: /灯里/ }).getAttribute("title")).toBe("Last check didn't finish: Couldn't reach pixiv");
  });

  it("空状态、首次使用说明与添加菜单", async () => {
    localStorage.clear();
    page(status({ login: { state: "loggedOut" } }));
    expect(await screen.findByRole("dialog", { name: /Subscribe to pixiv/ })).toBeTruthy();
    expectNoChinese(document.body);
    cleanup();
    page(status({ login: { state: "loggedOut" }, signingIn: true }));
    expect(await screen.findByText("Sign in in the window that opened")).toBeTruthy();
    expectNoChinese(document.body);
    cleanup();
    mockIPC((cmd) => (cmd === "subscriptions" || cmd === "subscription_recent" ? [] : null), { shouldMockEvents: true });
    page(status());
    expect(await screen.findByText("No subscriptions yet")).toBeTruthy();
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "Add subscription" })[0]);
    expect(await screen.findByRole("menuitem", { name: "pixiv bookmarks" })).toBeTruthy();
    expectNoChinese(document.body);
  });

  it("设置 › 订阅", () => {
    render(<SubscriptionSettings status={status()} onStatus={vi.fn()} error={null} onError={vi.fn()} />);
    expect(screen.getByText("Unofficial")).toBeTruthy();
    expectNoChinese(document.body, [account.name]);
  });
});
