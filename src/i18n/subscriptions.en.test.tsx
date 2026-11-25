import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { i18n } from ".";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SubscriptionSettings } from "../subscriptions/SubscriptionSettings";
import type { PixivWork } from "../bindings/PixivWork";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { SubscriptionsMain } from "../pixiv/SubscriptionsMain";
import { ToastProvider } from "../ui/Toast";
import { account, list, NOW, status } from "../subscriptions/subscriptions.fixtures";
import { expectNoChinese } from "../test/noChinese";
import { fakeBackend } from "../test/backend";

// 英文界面下订阅页与设置 › 订阅没有中文（#368、#461）。订阅名是画师的数据，不算。
const names = list.map((s) => s.name);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.setItem("kinshoko.subscriptions.firstRunSeen", "1");
  mockConvertFileSrc("windows");
  fakeBackend({ subscriptions: list, subscription_mark_seen: null });
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});
afterEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
  await act(async () => {
    await i18n.changeLanguage("zh-CN");
  });
});

const page = (s: SubscriptionStatus) =>
  render(
    <ToastProvider>
      <SaveDestinationProvider safe={false}>
        <SubscriptionsMain status={s} onStatus={vi.fn()} safe={false} onOpenSettings={vi.fn()} />
      </SaveDestinationProvider>
    </ToastProvider>,
  );

const work = (id: string): PixivWork => {
  const url = `https://i.pximg.net/img-master/${id}_p0.jpg`;
  return {
    id,
    kind: "illustration",
    title: `Work ${id}`,
    artist: { userId: "s1", name: "Mika" },
    tags: ["original"],
    explicit: false,
    width: 1000,
    height: 1400,
    pages: [{ preview: url, large: url, original: url }],
    postedAt: 0,
    bookmarked: false,
    followed: true,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
  };
};

describe("英文界面：订阅", () => {
  it("订阅页：五个去处、展开的一格与订阅设置", async () => {
    fakeBackend({
      subscriptions: list,
      subscription_mark_seen: null,
      subscription_browse: { works: [work("1"), work("2")], next: null },
      subscription_collected: [],
      subscription_previews: [],
      save_memory: { importDestination: null, newLibraryParent: null, pixivDestination: null },
      workspace_directories: { status: { revision: "t", libraries: [] }, registrationOrder: [], providers: [] },
    });
    for (const s of [status(), status({ login: { state: "expired", account } })]) {
      page(s);
      fireEvent.click(await screen.findByRole("button", { name: "Work 1, Mika" }));
      expect(await screen.findByRole("region", { name: "Work 1, Mika" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Subscription settings" })).toBeTruthy();
      expectNoChinese(document.body, names);
      cleanup();
    }
  });

  it("没登录时的空状态与首次使用说明", async () => {
    localStorage.clear();
    page(status({ login: { state: "loggedOut" } }));
    expect(await screen.findByRole("dialog", { name: /Subscribe to pixiv/ })).toBeTruthy();
    expectNoChinese(document.body);
    cleanup();
    page(status({ login: { state: "loggedOut" }, signingIn: true }));
    expect(await screen.findByText("Sign in in the window that opened")).toBeTruthy();
    expectNoChinese(document.body);
  });

  it("设置 › 订阅：检查状态", async () => {
    for (const [s, text] of [
      [status(), "Synced 10 minutes ago"],
      [status({ checking: true }), null],
      [status({ backoffUntil: NOW + 3_600_000 }), null],
    ] as const) {
      render(
        <SaveDestinationProvider safe={false}>
          <SubscriptionSettings status={s} onStatus={vi.fn()} error={null} onError={vi.fn()} />
        </SaveDestinationProvider>,
      );
      expect(screen.getByText("Unofficial")).toBeTruthy();
      await screen.findByText("Check for new works");
      if (text) expect(await screen.findByText(text)).toBeTruthy();
      expectNoChinese(document.body, [account.name]);
      cleanup();
    }
  });
});
