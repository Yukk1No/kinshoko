import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { ToastProvider } from "../ui/Toast";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { account, list, NOW, status } from "../subscriptions/subscriptions.fixtures";
import { AccountFloat } from "./AccountFloat";
import type { Subscriptions } from "./useSubscriptions";

// 订阅页右下角的 pixiv 头像卡：悬停长成卡片，检查新作、新订阅收进、图片大小、订阅设置、退出登录。

let fake: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mockConvertFileSrc("windows");
  fake = fakeBackend({
    subscriptions: list,
    subscription_check_now: null,
    subscription_logout: status({ login: { state: "loggedOut" } }),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function show(s: SubscriptionStatus, extra: { onOpenSettings?: () => void; onCommit?: (v: number) => void } = {}) {
  const onStatus = vi.fn();
  render(
    <ToastProvider>
      <SaveDestinationProvider safe={false}>
        <main>
          <AccountFloat
            status={s}
            onStatus={onStatus}
            density={{ value: 240, onCommit: extra.onCommit ?? vi.fn() }}
            onOpenSettings={extra.onOpenSettings ?? vi.fn()}
            subscriptions={{ list } as unknown as Subscriptions}
          />
        </main>
      </SaveDestinationProvider>
    </ToastProvider>,
  );
  const knob = screen.getByRole("button", { name: "pixiv 账号 yuki_sub" });
  return { knob, onStatus, card: () => screen.getByRole("group", { name: "pixiv 账号 yuki_sub" }) };
}

describe("订阅页的头像卡", () => {
  it("平时只是圆钮；悬停展开，移开收回", async () => {
    const { knob, card } = show(status());
    expect(knob.getAttribute("aria-expanded")).toBe("false");
    expect(card().hasAttribute("inert")).toBe(true);
    // 头像地址为空时用名字的首字。
    expect(within(knob).getByText("y")).toBeTruthy();
    const root = knob.closest(".pw-account") as HTMLElement;
    fireEvent.mouseEnter(root);
    expect(knob.getAttribute("aria-expanded")).toBe("true");
    expect(card().hasAttribute("inert")).toBe(false);
    expect(await within(card()).findByText("同步于 10 分钟前")).toBeTruthy();
    expect(within(card()).getByRole("slider", { name: "图片大小" })).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "订阅设置" })).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "退出登录" })).toBeTruthy();
    fireEvent.mouseLeave(root);
    expect(knob.getAttribute("aria-expanded")).toBe("false");
  });

  it("点过圆钮后移开也不收，Esc 收回并回到圆钮", () => {
    const { knob } = show(status());
    const root = knob.closest(".pw-account") as HTMLElement;
    fireEvent.mouseEnter(root);
    fireEvent.pointerDown(knob);
    fireEvent.click(knob, { detail: 1 });
    fireEvent.mouseLeave(root);
    expect(knob.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(knob, { key: "Escape" });
    expect(knob.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(knob);
  });

  it("检查新作、订阅设置与退出登录", async () => {
    const onOpenSettings = vi.fn();
    const { knob, card, onStatus } = show(status(), { onOpenSettings });
    fireEvent.click(knob);
    fireEvent.click(await within(card()).findByRole("button", { name: /检查新作/ }));
    await waitFor(() => expect(fake.calls("subscription_check_now")).toHaveLength(1));
    // 检查后卡片不收，好看到“正在检查”。
    expect(knob.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(knob, { key: "Escape" });
    fireEvent.click(knob);
    fireEvent.click(within(card()).getByRole("button", { name: "订阅设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(knob);
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: "退出登录" }));
    });
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ login: { state: "loggedOut" } })),
    );
  });

  it("登录失效时圆钮带警告点，卡片第一行是重新登录", () => {
    const { knob, card } = show(status({ login: { state: "expired", account } }));
    expect(knob.querySelector(".pw-account-dot")).toBeTruthy();
    fireEvent.click(knob);
    const items = within(card()).getAllByRole("button");
    expect(items[0].textContent).toBe("重新登录");
    expect(within(card()).getByText("登录已失效")).toBeTruthy();
  });

  it("有头像时显示头像；头像加载失败时回到首字", () => {
    const withAvatar = { ...account, avatar: "https://i.pximg.net/user-profile/img/a_170.jpg" };
    const { knob } = show(status({ login: { state: "loggedIn", account: withAvatar } }));
    const img = knob.querySelector("img");
    expect(img?.getAttribute("src")).toContain("user-profile/img/a_170.jpg");
    fireEvent.error(img!);
    expect(knob.querySelector("img")).toBeNull();
    expect(within(knob).getByText("y")).toBeTruthy();
  });

  it("淡出开始就释放通知锚点，卸载不再擦掉图片页刚写入的锚点", () => {
    const host = (leaving: boolean) => (
      <ToastProvider>
        <SaveDestinationProvider safe={false}>
          <main>
            <AccountFloat
              status={status()}
              onStatus={vi.fn()}
              density={null}
              onOpenSettings={vi.fn()}
              subscriptions={{ list } as unknown as Subscriptions}
              leaving={leaving}
            />
          </main>
        </SaveDestinationProvider>
      </ToastProvider>
    );
    const ui = render(host(false));
    const root = document.documentElement;
    expect(root.dataset.noticeHost).toBe("subscriptions");
    ui.rerender(host(true));
    expect(root.dataset.noticeHost).toBeUndefined();
    // 图片页接管后写入自己的锚点；旧的头像卡卸载时不能把它擦掉。
    root.style.setProperty("--k-notice-right", "24px");
    root.style.setProperty("--k-notice-bottom", "72px");
    root.style.setProperty("--k-notice-max", "320px");
    ui.unmount();
    expect(root.style.getPropertyValue("--k-notice-right")).toBe("24px");
    expect(root.style.getPropertyValue("--k-notice-bottom")).toBe("72px");
    expect(root.style.getPropertyValue("--k-notice-max")).toBe("320px");
    for (const name of ["--k-notice-right", "--k-notice-bottom", "--k-notice-max"]) root.style.removeProperty(name);
  });
});
