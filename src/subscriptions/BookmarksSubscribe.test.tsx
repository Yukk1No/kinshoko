import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { account, list, NOW, status, subscription } from "./subscriptions.fixtures";
import { type FakeBackend, fakeBackend } from "../test/backend";

// pixiv 收藏夹同步（#371）：首次开启时公开、非公开收藏各选同步多少，以及 R-18；已经在同步时添加菜单里这一项变灰。

let fake: FakeBackend;
const libraries = [
  { library: { id: "L1", name: "主图库", root: "C:/lib1" }, unavailable: null },
  { library: { id: "L2", name: "pixiv 收藏", root: "C:/lib2" }, unavailable: null },
];

function backend(subs: Subscription[]) {
  mockConvertFileSrc("windows");
  fake = fakeBackend({
    subscriptions: subs,
    subscription_recent: [],
    workspace_directories: { status: { revision: "t", libraries }, registrationOrder: [], providers: libraries.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) },
    subscription_add: [],
    subscription_set_options: () => subs[0],
  });
}

const sent = (command: string) => fake.calls(command).map((call) => call.args);

function page(s: SubscriptionStatus, safe = false) {
  return render(<SaveDestinationProvider safe={safe}>
    <SubscriptionsPage status={s} onStatus={vi.fn()} safe={safe} paneOpen onPaneToggle={vi.fn()} onOpenImage={vi.fn()} />
  </SaveDestinationProvider>);
}

async function openMenu() {
  fireEvent.click((await screen.findAllByRole("button", { name: "添加订阅" }))[0]);
  return screen.findByRole("menuitem", { name: "pixiv 收藏夹" });
}

const bookmarks = subscription("b1", "", { target: { kind: "pixivBookmarks" }, includeManga: true });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.setItem("kinshoko.subscriptions.firstRunSeen", "1");
});

afterEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("同步 pixiv 收藏夹", () => {
  it("默认两边都不同步已有的收藏、不同步漫画、同步 R-18，存进登记最早的图库", async () => {
    backend(list.filter((s) => s.target.kind !== "pixivBookmarks"));
    page(status());
    fireEvent.click(await openMenu());
    const dialog = await screen.findByRole("dialog", { name: "同步 pixiv 收藏夹" });
    expect(within(dialog).getByText("非官方")).toBeTruthy();
    for (const group of ["已有的公开收藏", "已有的非公开收藏"]) {
      expect(within(within(dialog).getByRole("radiogroup", { name: group })).getByRole("radio", { name: "不同步" })).toHaveProperty("checked", true);
    }
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "开始同步" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "开始同步" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("subscription_add")[0]).toEqual({ subscriptions: [{
      target: { kind: "pixivBookmarks" }, name: "", libraryId: "L1", includeExplicit: true, includeManga: false, backlog: { kind: "newOnly" }, privateBacklog: { kind: "newOnly" },
    }] });
  });

  it("公开收藏选最近 50 张、非公开全部同步，不同步 R-18", async () => {
    backend([]);
    page(status());
    fireEvent.click(await openMenu());
    const dialog = await screen.findByRole("dialog", { name: "同步 pixiv 收藏夹" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "最近几张公开收藏" }), { target: { value: "50" } });
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "已有的非公开收藏" })).getByRole("radio", { name: "全部" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "R-18 作品" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "开始同步" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "开始同步" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("subscription_add")[0]).toMatchObject({ subscriptions: [{ includeExplicit: false, backlog: { kind: "recent", count: 50 }, privateBacklog: { kind: "all" } }] });
  });

  it("账号没开 R-18 时不出现 R-18 一行，按默认收", async () => {
    backend([]);
    page(status({ login: { state: "loggedIn", account: { ...account, explicitAllowed: false } } }));
    fireEvent.click(await openMenu());
    const dialog = await screen.findByRole("dialog", { name: "同步 pixiv 收藏夹" });
    expect(within(dialog).queryByText("R-18 作品")).toBeNull();
  });

  it("已经在同步时菜单里变灰；名单上叫“我的收藏夹”，订阅设置改漫画与 R-18", async () => {
    backend([bookmarks]);
    page(status());
    expect((await openMenu()).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    const row = await screen.findByRole("button", { name: "我的收藏夹" });
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "订阅设置…" }));
    const dialog = await screen.findByRole("dialog", { name: "订阅设置" });
    expect(within(dialog).getByText("我的收藏夹")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("switch", { name: "漫画" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sent("subscription_set_options")).toEqual([{ id: "b1", includeExplicit: true, includeManga: false, top: null }]));
  });
});
