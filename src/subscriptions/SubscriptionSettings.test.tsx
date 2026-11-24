import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SubscriptionSettings } from "./SubscriptionSettings";
import { account, status } from "./subscriptions.fixtures";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { chooseOption } from "../test/select";

let backend: FakeBackend;

function serve() {
  backend = fakeBackend({
    set_subscriptions_enabled: (args) => status({ enabled: (args as { on: boolean }).on }),
    subscription_logout: status({ login: { state: "loggedOut" } }),
    subscription_login: null,
  });
}

const settings = (s: SubscriptionStatus, onStatus = vi.fn()) =>
  render(<SubscriptionSettings status={s} onStatus={onStatus} error={null} onError={vi.fn()} />);
const rows = () => screen.getAllByRole("listitem").map((row) => row.querySelector(".k-list-title")?.textContent);

describe("设置 › 订阅", () => {
  it("开着时：订阅功能、pixiv 账号与风险说明，标题旁标明非官方", () => {
    serve();
    settings(status());
    expect(screen.getByRole("heading", { name: "订阅" }).parentElement!.textContent).toContain("非官方");
    expect(rows()).toEqual(["订阅功能", "pixiv 账号", "风险说明"]);
    expect(screen.getByText("yuki_sub")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "订阅功能" }).getAttribute("aria-checked")).toBe("true");
  });

  it("关掉开关交给后端，新状态交回主窗口（入口跟着消失）", async () => {
    serve();
    const onStatus = vi.fn();
    settings(status(), onStatus);
    fireEvent.click(screen.getByRole("switch", { name: "订阅功能" }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
    expect(backend.calls("set_subscriptions_enabled")[0]?.args).toEqual({ on: false });
  });

  it("关着时只留开关；已登录的账号仍可退出", () => {
    serve();
    settings(status({ enabled: false, login: { state: "loggedOut" } }));
    expect(rows()).toEqual(["订阅功能"]);
    expect(screen.getByRole("switch", { name: "订阅功能" }).getAttribute("aria-checked")).toBe("false");
    cleanup();
    settings(status({ enabled: false, login: { state: "loggedIn", account } }));
    expect(rows()).toEqual(["订阅功能", "pixiv 账号"]);
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
  });

  it("没登录时可以登录；风险说明打开首次使用说明", async () => {
    serve();
    settings(status({ login: { state: "loggedOut" } }));
    expect(screen.getByText("未登录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(backend.calls("subscription_login")[0]?.args).toEqual({ title: "登录 pixiv" }));
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(await screen.findByRole("dialog", { name: /订阅 pixiv 新作/ })).toBeTruthy();
  });

  it("接上应用内浏览后多一行“新订阅收进”：没选过时是“和同类订阅放一起”，改了记下来", async () => {
    const libraries = [
      { library: { id: "L", name: "参考库", root: "C:/l" }, unavailable: null },
      { library: { id: "P", name: "pixiv", root: "C:/p" }, unavailable: null },
    ];
    backend = fakeBackend({
      workspace_directories: {
        status: { revision: "test", libraries },
        registrationOrder: [],
        providers: libraries.map((registration) => ({
          registration,
          sidebar: { all: 0, trash: 0, folders: [] },
          unassigned: 0,
          descendants: {},
        })),
      },
      save_memory: {
        importDestination: null,
        newLibraryParent: null,
        pixivDestination: { libraryId: "P", folderId: null },
        subscriptionDestination: null,
      },
      remember_subscription_destination: null,
    });
    render(
      <SaveDestinationProvider safe={false}>
        <SubscriptionSettings status={status()} onStatus={vi.fn()} error={null} onError={vi.fn()} browse />
      </SaveDestinationProvider>,
    );
    const library = await screen.findByRole("combobox", { name: "新订阅收进" });
    expect(rows()).toEqual(["订阅功能", "pixiv 账号", "新订阅收进", "风险说明"]);
    expect(library.textContent).toContain("和同类订阅放一起");
    await chooseOption(library, "参考库");
    await waitFor(() =>
      expect(backend.calls("remember_subscription_destination")[0]?.args).toEqual({
        destination: { libraryId: "L", folderId: null },
      }),
    );
    expect(library.getAttribute("data-value")).toBe("L");
  });
});
