import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { chooseOption } from "../test/select";
import { account, list, NOW, status, subscription } from "./subscriptions.fixtures";

// 订阅画师（#369）：添加对话框、从 pixiv 关注导入、订阅设置与退订。

let calls: { cmd: string; args: unknown }[] = [];
/** 让“slow”那次查找回来。 */
let finishSlow = () => {};
const registered = [
  { library: { id: "L1", name: "主图库", root: "C:/lib1" }, unavailable: null },
  { library: { id: "L2", name: "pixiv 画师", root: "C:/lib2" }, unavailable: null },
];

function backend(subs: Subscription[] = list, libraries = registered) {
  calls = [];
  mockWindows("main");
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "subscriptions") return subs;
    if (cmd === "plugin:library|create_library_unopened") {
      const { parent, name } = args as { parent: string; name: string };
      return { id: "L9", name, root: `${parent}/${name}` };
    }
    if (cmd === "subscription_recent") return [];
    if (cmd === "plugin:library|workspace_directories") {
      return { status: { revision: "t", libraries }, registrationOrder: [], providers: libraries.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) };
    }
    if (cmd === "subscription_find_artist") {
      const input = (args as { input: string }).input;
      if (input === "slow") return new Promise((resolve) => { finishSlow = () => resolve({ userId: "1", name: "Slow" }); });
      if (input.includes("404")) throw { code: "artistNotFound" };
      return { userId: "777", name: "Nanashi" };
    }
    if (cmd === "subscription_following") return [{ userId: "s1", name: "Mika" }, { userId: "21", name: "Akira" }, { userId: "22", name: "もち" }];
    if (cmd === "subscription_add") return [];
    return null;
  }, { shouldMockEvents: true });
}

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

function page(s: SubscriptionStatus, safe = false) {
  return render(<SaveDestinationProvider safe={safe}>
    <SubscriptionsPage status={s} onStatus={vi.fn()} safe={safe} paneOpen onPaneToggle={vi.fn()} onOpenImage={vi.fn()} />
  </SaveDestinationProvider>);
}

async function openArtistDialog() {
  fireEvent.click((await screen.findAllByRole("button", { name: "添加订阅" }))[0]);
  fireEvent.click(await screen.findByRole("menuitem", { name: "画师" }));
  return screen.findByRole("dialog", { name: "订阅画师" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.setItem("kinshoko.subscriptions.firstRunSeen", "1");
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("订阅画师", () => {
  it("输入主页链接后自动匹配，选最近几张，收进登记最早的可用资料库", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    const subscribe = within(dialog).getByRole("button", { name: "订阅" }) as HTMLButtonElement;
    expect(subscribe.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "画师主页链接或 ID" }), { target: { value: "https://www.pixiv.net/users/777" } });
    expect(within(dialog).getByRole("status", { name: "正在查找" })).toBeTruthy();
    expect(await within(dialog).findByText("Nanashi")).toBeTruthy();
    expect(within(dialog).queryByRole("status", { name: "正在查找" })).toBeNull();
    expect(within(dialog).getByText("pixiv ID 777")).toBeTruthy();
    // 默认仅同步新作；改成最近 5 张。
    expect((within(dialog).getByRole("radio", { name: /仅同步新作/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "最近几张" }), { target: { value: "5" } });
    expect((within(dialog).getByRole("radio", { name: /最近/ }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(subscribe.disabled).toBe(false));
    fireEvent.click(subscribe);
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("subscription_add")[0]).toEqual({ subscriptions: [{
      target: { kind: "pixivArtist", userId: "777" }, name: "Nanashi", libraryId: "L1",
      includeExplicit: true, includeManga: false, backlog: { kind: "recent", count: 5 },
    }] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("找不到画师时在输入框下说明；已订阅的画师不能再订阅", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    const input = within(dialog).getByRole("textbox", { name: "画师主页链接或 ID" });
    fireEvent.change(input, { target: { value: "404" } });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("未找到这位画师");
    // 查失败了按回车重查。
    fireEvent.submit(input);
    await waitFor(() => expect(sent("subscription_find_artist")).toHaveLength(2));
    cleanup();

    backend([subscription("777", "Nanashi")]);
    page(status());
    const again = await openArtistDialog();
    fireEvent.change(within(again).getByRole("textbox", { name: "画师主页链接或 ID" }), { target: { value: "777" } });
    expect(await within(again).findByText("已经订阅了这位画师")).toBeTruthy();
    expect((within(again).getByRole("button", { name: "订阅" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("查找期间改了输入，晚到的结果不算", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    const input = within(dialog).getByRole("textbox", { name: "画师主页链接或 ID" });
    fireEvent.change(input, { target: { value: "slow" } });
    await waitFor(() => expect(sent("subscription_find_artist")).toHaveLength(1));
    fireEvent.change(input, { target: { value: "777" } });
    finishSlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(dialog).queryByText("Slow")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "订阅" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await within(dialog).findByText("Nanashi")).toBeTruthy();
  });

  it("连续输入时只查停下来时的内容；清空后不查", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    const input = within(dialog).getByRole("textbox", { name: "画师主页链接或 ID" });
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.change(input, { target: { value: "77" } });
    fireEvent.change(input, { target: { value: "777" } });
    expect(await within(dialog).findByText("Nanashi")).toBeTruthy();
    expect(sent("subscription_find_artist")).toEqual([{ input: "777" }]);

    fireEvent.change(input, { target: { value: "" } });
    expect(within(dialog).queryByText("Nanashi")).toBeNull();
    expect(within(dialog).queryByRole("status", { name: "正在查找" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sent("subscription_find_artist")).toHaveLength(1);
  });

  it("登录着时有 R-18 与关注导入（安全模式开着也有）；不登录（登录失效）时都不出现", async () => {
    backend();
    page(status());
    let dialog = await openArtistDialog();
    expect(within(dialog).getByRole("switch", { name: "R-18 作品" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "从 pixiv 关注导入…" })).toBeTruthy();
    cleanup();

    backend();
    page(status({ login: { state: "expired", account } }));
    dialog = await openArtistDialog();
    expect(within(dialog).queryByText(/R-18/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "从 pixiv 关注导入…" })).toBeNull();
    cleanup();

    backend();
    page(status({ login: { state: "loggedIn", account: { ...account, explicitAllowed: false } } }));
    dialog = await openArtistDialog();
    expect(within(dialog).queryByText(/R-18/)).toBeNull();
    cleanup();

    // 安全模式只防社死：选项照常出现，R-18 的图才不上屏。
    backend();
    page(status(), true);
    dialog = await openArtistDialog();
    expect(within(dialog).getByRole("switch", { name: "R-18 作品" })).toBeTruthy();
  });

  it("从 pixiv 关注导入：已订阅的标出来，勾选的用同一套设置订阅", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "从 pixiv 关注导入…" }));
    const follows = await screen.findByRole("dialog", { name: "从 pixiv 关注导入" });
    await within(follows).findByText("Akira");
    const mika = within(follows).getByRole("checkbox", { name: /Mika/ }) as HTMLInputElement;
    expect(mika.disabled && mika.checked).toBe(true);
    expect(within(follows).getByText("已订阅")).toBeTruthy();
    fireEvent.click(within(follows).getByRole("checkbox", { name: /Akira/ }));
    expect(within(follows).getByText("已选 1 / 3 位")).toBeTruthy();
    fireEvent.click(within(follows).getByRole("switch", { name: "漫画" }));
    fireEvent.click(within(follows).getByRole("button", { name: "订阅 1 位画师" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("subscription_add")[0]).toEqual({ subscriptions: [{
      target: { kind: "pixivArtist", userId: "21" }, name: "Akira", libraryId: "L1",
      includeExplicit: true, includeManga: true, backlog: { kind: "newOnly" },
    }] });
  });

  it("名单行的更多菜单：订阅设置只改漫画与 R-18，退订要确认", async () => {
    backend();
    page(status());
    fireEvent.click((await screen.findAllByRole("button", { name: "更多" }))[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "订阅设置…" }));
    const settings = await screen.findByRole("dialog", { name: "订阅设置" });
    expect(within(settings).queryByText("旧作")).toBeNull();
    fireEvent.click(within(settings).getByRole("switch", { name: "R-18 作品" }));
    fireEvent.click(within(settings).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sent("subscription_set_options")).toEqual([{ id: "s1", includeExplicit: false, includeManga: false, top: null }]));

    fireEvent.click(screen.getAllByRole("button", { name: "更多" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "退订" }));
    const confirm = await screen.findByRole("dialog", { name: "退订 Mika？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "退订" }));
    await waitFor(() => expect(sent("subscription_remove")).toEqual([{ id: "s1" }]));
  });

  it("图库下拉里就地新建图库：叠一层对话框，建好后回来选中它，已填的都在，不切换主窗口（#442）", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "画师主页链接或 ID" }), { target: { value: "777" } });
    expect(await within(dialog).findByText("Nanashi")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: /全部/ }));

    await chooseOption(within(dialog).getByRole("combobox", { name: "图库" }), "新建图库…");
    const create = await screen.findByRole("dialog", { name: "新建图库" });
    fireEvent.change(within(create).getByLabelText("图库名称"), { target: { value: "画师新作" } });
    window.__KINSHOKO_TEST_PICKS__ = ["D:/参考"];
    fireEvent.click(within(create).getByRole("button", { name: "选择存放位置…" }));
    expect(await within(create).findByText("D:/参考\\画师新作")).toBeTruthy();
    fireEvent.click(within(create).getByRole("button", { name: "新建图库" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建图库" })).toBeNull());
    expect(sent("plugin:library|create_library_unopened")).toEqual([{ parent: "D:/参考", name: "画师新作" }]);
    expect(sent("plugin:library|create_library")).toEqual([]);
    expect(sent("plugin:library|remember_new_library_parent")).toEqual([{ parent: "D:/参考" }]);
    expect(screen.getByRole("dialog", { name: "订阅画师" })).toBe(dialog);
    expect(within(dialog).getByText("Nanashi")).toBeTruthy();
    expect((within(dialog).getByRole("radio", { name: /全部/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByRole("combobox", { name: "图库" }).textContent).toContain("画师新作");

    fireEvent.click(within(dialog).getByRole("button", { name: "订阅" }));
    await waitFor(() => expect(sent("subscription_add")).toHaveLength(1));
    expect(sent("subscription_add")[0]).toMatchObject({ subscriptions: [{ libraryId: "L9", backlog: { kind: "all" } }] });
  });

  it("取消就地新建时图库下拉回到原来的选项", async () => {
    backend();
    page(status());
    const dialog = await openArtistDialog();
    const library = within(dialog).getByRole("combobox", { name: "图库" });
    await chooseOption(library, "pixiv 画师");
    await chooseOption(library, "新建图库…");
    const create = await screen.findByRole("dialog", { name: "新建图库" });
    fireEvent.click(within(create).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建图库" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "订阅画师" })).toBeTruthy();
    expect(library.getAttribute("data-value")).toBe("L2");
    expect(sent("plugin:library|create_library_unopened")).toEqual([]);
  });

  it("一个图库都没有时，在订阅对话框里新建图库后能订阅", async () => {
    backend(list, []);
    page(status());
    const dialog = await openArtistDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "画师主页链接或 ID" }), { target: { value: "777" } });
    expect(await within(dialog).findByText("Nanashi")).toBeTruthy();
    const subscribe = within(dialog).getByRole("button", { name: "订阅" }) as HTMLButtonElement;
    expect(subscribe.disabled).toBe(true);

    await chooseOption(within(dialog).getByRole("combobox", { name: "图库" }), "新建图库…");
    const create = await screen.findByRole("dialog", { name: "新建图库" });
    window.__KINSHOKO_TEST_PICKS__ = ["D:/参考"];
    fireEvent.click(within(create).getByRole("button", { name: "选择存放位置…" }));
    await within(create).findByText("D:/参考\\我的参考");
    fireEvent.click(within(create).getByRole("button", { name: "新建图库" }));
    await waitFor(() => expect(subscribe.disabled).toBe(false));
    fireEvent.click(subscribe);
    await waitFor(() => expect(sent("subscription_add")[0]).toMatchObject({ subscriptions: [{ libraryId: "L9" }] }));
  });

  it("选中一位画师时标题行写出跳过的动图", async () => {
    backend([subscription("s1", "Mika", { skipped: 2 })]);
    page(status());
    fireEvent.click(await screen.findByRole("button", { name: "Mika" }));
    expect(await screen.findByText("跳过 2 个动图")).toBeTruthy();
  });
});
