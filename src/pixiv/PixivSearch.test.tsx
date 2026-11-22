import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { ArtistsPage } from "../bindings/ArtistsPage";
import type { Feed } from "../bindings/Feed";
import type { PixivWork } from "../bindings/PixivWork";
import type { Subscription } from "../bindings/Subscription";
import type { WorksPage } from "../bindings/WorksPage";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { PixivHome } from "./PixivHome";

// 应用内浏览（#461 第 5 步）：搜索作品与画师、“画师”页里原地筛选、在 pixiv 上关注。

function work(id: string, artist = { userId: "77", name: "小林" }, followed = false): PixivWork {
  const page = {
    preview: `https://i.pximg.net/c/540x540_70/img-master/${id}_p0.jpg`,
    large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p0.jpg`,
    original: `https://i.pximg.net/img-original/${id}_p0.png`,
  };
  return {
    id,
    kind: "illustration",
    title: `作品${id}`,
    artist,
    tags: [],
    explicit: false,
    width: 1000,
    height: 1400,
    pages: [page],
    postedAt: 0,
    bookmarked: false,
    followed,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
  };
}

function artistSubscription(userId: string, name: string): Subscription {
  return {
    id: `s${userId}`,
    target: { kind: "pixivArtist", userId },
    name,
    libraryId: "lib",
    includeExplicit: true,
    includeManga: false,
    backlog: { kind: "newOnly" } as Subscription["backlog"],
    since: null,
    skipped: 0,
    createdAt: 0,
    lastCheckedAt: null,
    lastError: null,
    lastFailedAt: null,
  };
}

let fake: FakeBackend;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  HTMLElement.prototype.scrollTo = () => {};
  fake = fakeBackend({
    subscription_browse: (args) => {
      const feed = args.feed as Feed;
      if (feed.kind === "search") return { works: [work(`搜${feed.word}`)], next: null } satisfies WorksPage;
      if (feed.kind === "artist")
        return { works: [work(`画${feed.userId}`, { userId: feed.userId, name: "x" }, true)], next: null };
      return { works: [work(feed.kind)], next: null } satisfies WorksPage;
    },
    subscription_search_artists: (args) =>
      ({
        artists: [
          { userId: "31", name: `${args.word}一号`, avatar: null, followed: false, works: [] },
          { userId: "32", name: `${args.word}二号`, avatar: null, followed: true, works: [] },
        ],
        next: null,
      }) satisfies ArtistsPage,
    subscription_find_artist: (args) => ({ userId: String(args.input), name: "按 ID 找到的" }),
    subscription_set_follow: null,
    subscription_collected: [],
    subscriptions: [artistSubscription("2", "山田"), artistSubscription("1", "阿部")],
  });
});
afterEach(cleanup);

const places = () => screen.queryByRole("group", { name: "订阅去处" });
const place = (name: string) => within(places() as HTMLElement).getByRole("button", { name });
const searchBox = () => screen.getByRole("searchbox", { name: "搜索" });

describe("订阅页的搜索", () => {
  it("点图标展开搜索，五个去处让开；回车后墙换成结果；Esc 收回，回到原来的去处，结果不保留", async () => {
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品following，小林" });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(places()).toBeNull();
    expect(screen.getByRole("group", { name: "找什么" })).toBeTruthy();
    fireEvent.change(searchBox(), { target: { value: "夏" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await screen.findByRole("button", { name: "作品搜夏，小林" });
    expect(screen.queryByRole("button", { name: "作品following，小林" })).toBeNull();
    // 查找词留在框里。
    expect(searchBox()).toHaveProperty("value", "夏");
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(place("新作").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "作品following，小林" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "作品搜夏，小林" })).toBeNull();
  });

  it("Ctrl+F 和 / 都能打开搜索；框空着点到别处时收回", async () => {
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品following，小林" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(searchBox()).toBeTruthy();
    fireEvent.blur(searchBox(), { relatedTarget: document.body });
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.keyDown(window, { key: "/" });
    expect(searchBox()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("找画师：列出 pixiv 上的画师，可以关注；点一位看作品", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(within(screen.getByRole("group", { name: "找什么" })).getByRole("button", { name: "画师" }));
    fireEvent.change(searchBox(), { target: { value: "林" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    const list = await screen.findByRole("list", { name: "画师" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[1]).getByRole("button", { name: "已关注" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(rows[0]).getByRole("button", { name: "关注" }));
    expect(fake.calls("subscription_set_follow")[0].args).toEqual({ userId: "31", on: true });
    expect(within(rows[0]).getByRole("button", { name: "已关注" })).toBeTruthy();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /林一号/ }));
    expect(screen.getByRole("heading", { name: "林一号" })).toBeTruthy();
    expect(place("画师").getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("button", { name: "作品画31，x" });
  });

  it("找画师时输入数字 ID 直接打开这位画师", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(within(screen.getByRole("group", { name: "找什么" })).getByRole("button", { name: "画师" }));
    fireEvent.change(searchBox(), { target: { value: "12345" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "按 ID 找到的" })).toBeTruthy();
    expect(fake.calls("subscription_search_artists")).toHaveLength(0);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("在“画师”页里搜索是原地按名字筛选名单，没有作品｜画师切换", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(place("画师"));
    await screen.findByRole("list", { name: "画师" });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(screen.queryByRole("group", { name: "找什么" })).toBeNull();
    fireEvent.change(searchBox(), { target: { value: "山" } });
    const names = within(screen.getByRole("list", { name: "画师" }))
      .getAllByRole("button")
      .flatMap((b) => b.querySelector(".pw-artist-name")?.textContent ?? []);
    expect(names).toEqual(["山田"]);
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(fake.calls("subscription_browse").some((c) => (c.args.feed as Feed).kind === "search")).toBe(false);
    fireEvent.change(searchBox(), { target: { value: "没有这个人" } });
    expect(screen.getByRole("status").textContent).toBe("没有名字对得上的画师");
  });
});

describe("搜索的边角", () => {
  it("输入法选字时的回车和 Esc 不算", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(searchBox(), { target: { value: "なつ" } });
    fireEvent.keyDown(searchBox(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(searchBox(), { key: "Escape", keyCode: 229 });
    expect(searchBox()).toHaveProperty("value", "なつ");
    expect(fake.calls("subscription_browse").some((c) => (c.args.feed as Feed).kind === "search")).toBe(false);
  });

  it("按 ID 找画师还没回来时收起了搜索，回来也不再打开这位画师", async () => {
    let answer: (artist: { userId: string; name: string }) => void = () => {};
    fake.on("subscription_find_artist", () => new Promise<{ userId: string; name: string }>((done) => (answer = done)));
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品following，小林" });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(within(screen.getByRole("group", { name: "找什么" })).getByRole("button", { name: "画师" }));
    fireEvent.change(searchBox(), { target: { value: "12345" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await waitFor(() => expect(fake.calls("subscription_find_artist")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    await act(async () => answer({ userId: "12345", name: "迟到的" }));
    expect(screen.queryByRole("heading", { name: "迟到的" })).toBeNull();
    expect(place("新作").getAttribute("aria-pressed")).toBe("true");
  });

  it("搜到的画师一页放不满时接着读下一页", async () => {
    fake.on("subscription_search_artists", (args) =>
      args.next === null
        ? {
            artists: [{ userId: "31", name: "一号", avatar: null, followed: false, works: [] }],
            next: "https://app-api.pixiv.net/v1/search/user?word=x&offset=30",
          }
        : { artists: [{ userId: "41", name: "二页", avatar: null, followed: false, works: [] }], next: null },
    );
    render(<PixivHome safe={false} />);
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(within(screen.getByRole("group", { name: "找什么" })).getByRole("button", { name: "画师" }));
    fireEvent.change(searchBox(), { target: { value: "x" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await screen.findByRole("button", { name: /二页/ });
    expect(fake.calls("subscription_search_artists")).toHaveLength(2);
  });
});

describe("在 pixiv 上关注", () => {
  it("展开的一格里关注画师；画师页顶上的关注按读到的作品显示", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "作品following，小林" }));
    const band = screen.getByRole("region", { name: "作品following，小林" });
    fireEvent.click(within(band).getByRole("button", { name: "关注" }));
    await waitFor(() => expect(fake.calls("subscription_set_follow")).toHaveLength(1));
    expect(fake.calls("subscription_set_follow")[0].args).toEqual({ userId: "77", on: true });
    expect(within(band).getByRole("button", { name: "已关注" })).toBeTruthy();

    fireEvent.click(place("画师"));
    fireEvent.click(within(await screen.findByRole("list", { name: "画师" })).getByRole("button", { name: /^山田/ }));
    await screen.findByRole("button", { name: "作品画2，x" });
    // 画师 2 的作品里带着“已关注”；他也在订阅里，所以写“已关注，自动收”。
    expect((await screen.findByRole("button", { name: "已关注，自动收" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("写的时候按钮不能再点；失败时回到写之前的样子", async () => {
    let fail: (error: unknown) => void = () => {};
    fake.on("subscription_set_follow", () => new Promise((_, reject) => (fail = reject)));
    render(<PixivHome safe={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "作品following，小林" }));
    const band = screen.getByRole("region", { name: "作品following，小林" });
    fireEvent.click(within(band).getByRole("button", { name: "关注" }));
    const button = within(band).getByRole("button", { name: "已关注" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(fake.calls("subscription_set_follow")).toHaveLength(1);
    await act(async () => fail({ code: "subscriptionSource", reason: { code: "network" } }));
    expect(within(band).getByRole("button", { name: "关注" })).toHaveProperty("disabled", false);
  });

  it("关注写失败时改回来并说明", async () => {
    fake.on("subscription_set_follow", () => {
      throw { code: "subscriptionSource", reason: { code: "network" } };
    });
    render(<PixivHome safe={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "作品following，小林" }));
    const band = screen.getByRole("region", { name: "作品following，小林" });
    fireEvent.click(within(band).getByRole("button", { name: "关注" }));
    expect((await screen.findByRole("alert")).textContent).toContain("没关注上");
    expect(within(band).getByRole("button", { name: "关注" }).getAttribute("aria-pressed")).toBe("false");
  });
});
