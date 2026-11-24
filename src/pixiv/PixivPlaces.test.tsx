import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { Feed } from "../bindings/Feed";
import type { PixivWork } from "../bindings/PixivWork";
import type { Subscription } from "../bindings/Subscription";
import type { Target } from "../bindings/Target";
import type { WorksPage } from "../bindings/WorksPage";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { PixivHome } from "./PixivHome";

// 应用内浏览（#461 第 4 步）：标题行的五个去处，榜单、我的收藏、画师各自一面墙。

function work(id: string, artist = { userId: "9", name: "画师" }): PixivWork {
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
    followed: false,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
  };
}

function subscription(id: string, name: string, target: Target): Subscription {
  return {
    id,
    target,
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

/** 每条流给一张能认出来的作品：id 就是流的内容。 */
function feedId(feed: Feed): string {
  switch (feed.kind) {
    case "ranking":
      return `榜${feed.period}`;
    case "bookmarks":
      return feed.private ? "藏私" : "藏公";
    case "artist":
      return `${feed.userId}${feed.manga ? "漫" : "插"}`;
    default:
      return feed.kind;
  }
}

let fake: FakeBackend;
let scrolls: number;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  // jsdom 没有 scrollTo；换到另一段时墙会滚到那一段的开头。
  scrolls = 0;
  HTMLElement.prototype.scrollTo = () => {
    scrolls += 1;
  };
  fake = fakeBackend({
    subscription_browse: (args) => {
      const feed = args.feed as Feed;
      return { works: [work(feedId(feed), { userId: "77", name: "小林" })], next: null } satisfies WorksPage;
    },
    subscription_collected: [],
    subscriptions: [
      subscription("s1", "山田", { kind: "pixivArtist", userId: "2" }),
      subscription("s2", "日榜前 50", { kind: "pixivRanking", period: "day", top: 50, explicit: false }),
      subscription("s3", "阿部", { kind: "pixivArtist", userId: "1" }),
      subscription("s4", "收藏夹", { kind: "pixivBookmarks" }),
    ],
  });
});
afterEach(cleanup);

const place = (name: string) => within(screen.getByRole("group", { name: "订阅去处" })).getByRole("button", { name });
const feeds = () => fake.calls("subscription_browse").map((c) => feedId(c.args.feed as Feed));

describe("订阅页的去处", () => {
  it("标题行正中依次是新作、推荐、榜单、我的收藏、画师", async () => {
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品following，小林" });
    const names = within(screen.getByRole("group", { name: "订阅去处" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["新作", "推荐", "榜单", "我的收藏", "画师"]);
  });

  it("榜单默认读全年龄日榜，可以换周榜、月榜；回到新作时墙还在，不重读", async () => {
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品recommended，小林" });
    fireEvent.click(place("榜单"));
    await screen.findByRole("button", { name: "作品榜day，小林" });
    // 新作与推荐那面墙藏起来了。
    expect(screen.queryByRole("button", { name: "作品following，小林" })).toBeNull();
    const ranking = fake.calls("subscription_browse").at(-1)?.args.feed;
    expect(ranking).toEqual({ kind: "ranking", period: "day", explicit: false });
    fireEvent.click(screen.getByRole("button", { name: "周榜" }));
    await screen.findByRole("button", { name: "作品榜week，小林" });
    fireEvent.click(screen.getByRole("button", { name: "月榜" }));
    await screen.findByRole("button", { name: "作品榜month，小林" });

    fireEvent.click(place("新作"));
    expect(screen.getByRole("button", { name: "作品following，小林" })).toBeTruthy();
    expect(feeds().filter((f) => f === "following")).toHaveLength(1);
    // 回到上次停的那一段时墙不滚，停在原处；换到推荐才滚过去。
    expect(scrolls).toBe(0);
    fireEvent.click(place("推荐"));
    expect(scrolls).toBe(1);
  });

  it("看全图时换了榜单周期，全图收起，墙换成新的榜单", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(place("榜单"));
    fireEvent.click(await screen.findByRole("button", { name: "作品榜day，小林" }));
    fireEvent.click(screen.getByRole("button", { name: "看全图" }));
    expect(screen.getByRole("group", { name: "第 1 页，共 1 页" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "周榜" }));
    await screen.findByRole("button", { name: "作品榜week，小林" });
    expect(screen.queryByRole("group", { name: "第 1 页，共 1 页" })).toBeNull();
  });

  it("我的收藏先看公开的，可以换成非公开", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(place("我的收藏"));
    await screen.findByRole("button", { name: "作品藏公，小林" });
    fireEvent.click(screen.getByRole("button", { name: "非公开" }));
    await screen.findByRole("button", { name: "作品藏私，小林" });
  });

  it("画师是订阅了的画师（不含榜单和收藏夹），按名字排；点一位看作品，可换漫画，再回到名单", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(place("画师"));
    const list = await screen.findByRole("list", { name: "画师" });
    const names = [...list.querySelectorAll(".pw-artist-name")].map((b) => b.textContent);
    expect(names).toEqual(["阿部", "山田"]);
    fireEvent.click(within(list).getByRole("button", { name: "看 山田 的作品" }));
    expect(screen.getByRole("heading", { name: "山田" })).toBeTruthy();
    await screen.findByRole("button", { name: "作品2插，小林" });
    expect(screen.getByRole("link", { name: "在 pixiv 打开" }).getAttribute("href")).toBe(
      "https://www.pixiv.net/users/2",
    );
    fireEvent.click(screen.getByRole("button", { name: "漫画" }));
    await screen.findByRole("button", { name: "作品2漫，小林" });
    fireEvent.click(screen.getByRole("button", { name: "全部画师" }));
    await screen.findByRole("list", { name: "画师" });
  });

  it("还没订阅画师时说明", async () => {
    fake.on("subscriptions", []);
    render(<PixivHome safe={false} />);
    fireEvent.click(place("画师"));
    // 先是读取中（转圈），读完才是空状态。
    expect((await screen.findByText("还没有订阅画师")).closest("[role=status]")).not.toBeNull();
  });

  it("展开的一格里“查看这位画师”换到这位画师的作品；画师页里不再给这个按钮", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "作品following，小林" }));
    fireEvent.click(screen.getByRole("button", { name: "查看这位画师" }));
    expect(place("画师").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "小林" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "作品77插，小林" }));
    expect(screen.queryByRole("button", { name: "查看这位画师" })).toBeNull();
  });
});
