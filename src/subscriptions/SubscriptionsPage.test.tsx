import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ReceivedImage } from "../bindings/ReceivedImage";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { account, list, NOW, recent, status } from "./subscriptions.fixtures";
import { KINDS, type KindMount } from "./kinds";

let calls: { cmd: string; args: unknown }[] = [];

function backend(subs: Subscription[] = list, images: ReceivedImage[] = recent) {
  calls = [];
  mockWindows("main");
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "subscriptions") return subs;
    if (cmd === "subscription_recent") return images;
    if (cmd === "subscription_cancel_login") return status({ login: { state: "loggedOut" } });
    if (cmd === "subscription_logout") return status({ login: { state: "loggedOut" } });
    return null;
  }, { shouldMockEvents: true });
}

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

function page(s: SubscriptionStatus, { safe = false, onOpenImage = vi.fn(), kinds }: { safe?: boolean; onOpenImage?: () => void; kinds?: KindMount[] } = {}) {
  const props = { status: s, onStatus: vi.fn(), paneOpen: true, onPaneToggle: vi.fn(), onOpenImage, kinds };
  const view = render(<SubscriptionsPage {...props} safe={safe} />);
  return { ...view, setSafe: (next: boolean) => view.rerender(<SubscriptionsPage {...props} safe={next} />), props };
}

const tiles = () => screen.queryAllByRole("button", { name: "在图库中打开" });
const pane = () => screen.getByRole("complementary", { name: "订阅" });

beforeEach(() => {
  // 只固定“现在”：菜单的动画帧要真的计时器。
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

describe("订阅页", () => {
  it("名单按画师、榜单、收藏夹分组，新收到与之前分两段，打开订阅页即标为已看", async () => {
    backend();
    page(status({ newCount: 3 }));
    await waitFor(() => expect(tiles()).toHaveLength(5));
    expect(within(pane()).getByRole("region", { name: "画师" })).toBeTruthy();
    expect(within(pane()).getByRole("region", { name: "榜单" })).toBeTruthy();
    expect(within(pane()).getByRole("region", { name: "pixiv 收藏夹" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "新收到" })).getAllByRole("button")).toHaveLength(3);
    expect(within(screen.getByRole("region", { name: "之前" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /最近收到\s*5 张/ })).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Mika/ })).getByText("2")).toBeTruthy();
    expect(screen.getByText("非官方").getAttribute("title")).toBe("pixiv 没有开放接口，这是 Kinshoko 自己做的");
    await waitFor(() => expect(sent("subscription_mark_seen")).toHaveLength(1));
  });

  it("上次没查完的订阅带警示图标，悬停说明原因", async () => {
    backend();
    page(status());
    const row = await screen.findByRole("button", { name: /灯里/ });
    expect(within(row).getByRole("img", { name: "上次没查完" })).toBeTruthy();
    expect(row.getAttribute("title")).toBe("上次没查完：连不上 pixiv");
  });

  it("点名单里的一条只看它收进来的图，再点回到全部", async () => {
    backend();
    page(status());
    await waitFor(() => expect(tiles()).toHaveLength(5));
    fireEvent.click(screen.getByRole("button", { name: /日榜 前 50/ }));
    expect(tiles()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /全部订阅/ }));
    expect(tiles()).toHaveLength(5);
  });

  it("点图在图库中打开", async () => {
    backend();
    const onOpenImage = vi.fn();
    page(status(), { onOpenImage });
    await waitFor(() => expect(tiles()).toHaveLength(5));
    fireEvent.click(tiles()[0]);
    expect(onOpenImage).toHaveBeenCalledWith("L1", "n1");
  });

  it("安全模式切换时成人作品与 R-18 订阅立即隐藏、出现，不出现 R-18 字样", async () => {
    backend();
    const kinds = KINDS.map((k) => (k.kind === "ranking" ? { ...k, hiddenWhenSafe: () => true } : k));
    const view = page(status(), { kinds });
    await waitFor(() => expect(tiles()).toHaveLength(5));
    view.setSafe(true);
    // 不等后端重读：这次渲染里就不见了。
    expect(tiles()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /日榜/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "榜单" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/R-?18/i);
    view.setSafe(false);
    expect(tiles()).toHaveLength(5);
    expect(screen.getByRole("button", { name: /日榜 前 50/ })).toBeTruthy();
  });

  it("缩略图读不出来的先不显示，换了安全模式再试", async () => {
    backend();
    const view = page(status(), { safe: true });
    await waitFor(() => expect(tiles()).toHaveLength(3));
    fireEvent.error(tiles()[0].querySelector("img")!);
    expect(tiles()).toHaveLength(2);
    view.setSafe(false);
    expect(tiles()).toHaveLength(5);
  });

  it("空闲时标题行右侧是“几分钟前查过”与立即检查", async () => {
    backend();
    page(status());
    expect(await screen.findByText("10 分钟前查过")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即检查" }));
    await waitFor(() => expect(sent("subscription_check_now")).toHaveLength(1));
  });

  it("检查中只显示“正在检查”，没有立即检查", async () => {
    backend();
    page(status({ checking: true }));
    expect((await screen.findByRole("status")).textContent).toBe("正在检查");
    expect(screen.queryByRole("button", { name: "立即检查" })).toBeNull();
  });

  it("限流退避中显示几点再查，悬停说明是 pixiv 限制了请求次数", async () => {
    backend();
    const until = new Date(NOW);
    until.setHours(14, 30, 0, 0);
    page(status({ backoffUntil: Math.max(until.getTime(), NOW + 60_000) }));
    const line = await screen.findByRole("status");
    expect(line.textContent).toMatch(/^\d\d:\d\d 再查$/);
    expect(line.getAttribute("title")).toBe("pixiv 限制了请求次数，到时会自动再查");
    expect(screen.queryByRole("button", { name: "立即检查" })).toBeNull();
  });

  it("登录失效：顶部横幅与账号行都能重新登录，标题行不显示检查状态", async () => {
    backend();
    page(status({ login: { state: "expired", account } }));
    expect(await screen.findByText("pixiv 登录已失效，检查已暂停")).toBeTruthy();
    expect(screen.getByText("登录已失效")).toBeTruthy();
    expect(screen.queryByText("10 分钟前查过")).toBeNull();
    const again = screen.getAllByRole("button", { name: "重新登录" });
    expect(again).toHaveLength(2);
    fireEvent.click(again[0]);
    await waitFor(() => expect(sent("subscription_login")).toEqual([{ title: "登录 pixiv" }]));
  });

  it("没登录：空状态请画师登录，第一次打开时弹出首次使用说明", async () => {
    localStorage.clear();
    backend();
    page(status({ login: { state: "loggedOut" } }));
    const dialog = await screen.findByRole("dialog", { name: /订阅 pixiv 新作/ });
    expect(within(dialog).getByText("非官方")).toBeTruthy();
    expect(within(dialog).getByText("账号可能被警告或停用")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "以后再说" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(localStorage.getItem("kinshoko.subscriptions.firstRunSeen")).toBe("1");
    expect(screen.getByRole("heading", { name: "登录 pixiv，开始订阅" })).toBeTruthy();
    expect(screen.getByText("未登录 pixiv")).toBeTruthy();
    expect(sent("subscriptions")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "风险说明" }));
    const again = await screen.findByRole("dialog");
    fireEvent.click(within(again).getByRole("button", { name: "知道了，去登录" }));
    await waitFor(() => expect(sent("subscription_login")).toHaveLength(1));
  });

  it("看过说明后不再自动弹出", async () => {
    backend();
    page(status({ login: { state: "loggedOut" } }));
    await screen.findByRole("heading", { name: "登录 pixiv，开始订阅" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("正在登录：可以取消或回到登录窗口", async () => {
    backend();
    page(status({ login: { state: "loggedOut" }, signingIn: true }));
    expect(await screen.findByRole("heading", { name: "在弹出的窗口里登录" })).toBeTruthy();
    expect(within(pane()).getByText("正在登录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "回到登录窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(sent("subscription_cancel_login")).toHaveLength(1));
    expect(sent("subscription_login")).toHaveLength(1);
  });

  it("已登录、还没有订阅：添加订阅的三项先不能用（#369–#371 接上）", async () => {
    backend([], []);
    page(status());
    expect(await screen.findByRole("heading", { name: "还没有订阅" })).toBeTruthy();
    // 等最近收到的图也读完，免得点下去时页面还在换内容。
    await act(async () => {});
    expect(screen.queryByText("10 分钟前查过")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "添加订阅" })[1]);
    await screen.findByRole("menuitem", { name: "画师" });
    for (const name of ["画师", "榜单", "pixiv 收藏夹"]) {
      expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("挂上添加流程的一类可以用", async () => {
    backend([], []);
    const add = vi.fn();
    page(status(), { kinds: KINDS.map((k) => (k.kind === "artist" ? { ...k, add } : k)) });
    fireEvent.click((await screen.findAllByRole("button", { name: "添加订阅" }))[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "画师" }));
    expect(add).toHaveBeenCalled();
  });

  it("账号菜单：风险说明与退出登录", async () => {
    backend();
    const view = page(status());
    fireEvent.click(await screen.findByRole("button", { name: "账号" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    await waitFor(() => expect(sent("subscription_logout")).toHaveLength(1));
    await waitFor(() => expect(view.props.onStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "账号" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "风险说明" }));
    const dialog = await screen.findByRole("dialog");
    // 已登录时只有“知道了”。
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["知道了"]);
  });

  it("这次打开期间收到的图留在“新收到”，状态推送后照样排在前面", async () => {
    backend();
    const view = page(status());
    await waitFor(() => expect(tiles()).toHaveLength(5));
    // 标为已看之后后端再列出来时都不是新的了。
    backend(list, recent.map((image) => ({ ...image, new: false })));
    await act(async () => { view.rerender(<SubscriptionsPage {...view.props} status={status({ checking: true })} safe={false} />); });
    await waitFor(() => expect(sent("subscription_recent")).toHaveLength(1));
    expect(within(screen.getByRole("region", { name: "新收到" })).getAllByRole("button")).toHaveLength(3);
  });
});
