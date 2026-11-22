import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { PixivWork } from "../bindings/PixivWork";
import type { WorksPage } from "../bindings/WorksPage";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { PixivHome } from "./PixivHome";

// 应用内浏览（#461 第 2 步）：先新作后推荐，点图原地展开，安全模式藏起 R-18。

function work(id: string, extra: Partial<PixivWork> = {}): PixivWork {
  const page = {
    preview: `https://i.pximg.net/c/540x540_70/img-master/${id}_p0.jpg`,
    large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p0.jpg`,
    original: `https://i.pximg.net/img-original/${id}_p0.png`,
  };
  return {
    id,
    kind: "illustration",
    title: `作品${id}`,
    artist: { userId: "9", name: "画师" },
    tags: ["オリジナル"],
    explicit: false,
    width: 1000,
    height: 1400,
    pages: [page],
    postedAt: 0,
    bookmarked: false,
    followed: false,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
    ...extra,
  };
}

let fake: FakeBackend;
let recommendedPages: number;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  recommendedPages = 0;
  fake = fakeBackend({
    subscription_browse: (args) => {
      const feed = args.feed as { kind: string };
      if (feed.kind === "following")
        return {
          works: [
            work("1"),
            work("2", { explicit: true }),
            work("3", { pages: [work("3").pages[0], work("3").pages[0]] }),
          ],
          next: "https://app-api.pixiv.net/v2/illust/follow?offset=30",
        } satisfies WorksPage;
      recommendedPages += 1;
      const base = recommendedPages * 10;
      return {
        works: [work(String(base)), work(String(base + 1)), work("1")],
        next: recommendedPages < 3 ? `https://app-api.pixiv.net/v1/illust/recommended?offset=${base}` : null,
      } satisfies WorksPage;
    },
  });
});
afterEach(cleanup);

describe("订阅页主区", () => {
  it("新作只读一页，读完接着读推荐；推荐里和新作重复的作品不再出现", async () => {
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品10，画师" });
    const calls = fake.calls("subscription_browse").map((c) => (c.args.feed as { kind: string }).kind);
    expect(calls.slice(0, 2)).toEqual(["following", "recommended"]);
    expect(calls.filter((k) => k === "following")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "作品1，画师" })).toHaveLength(1);
    // 多页作品标页数。
    expect(
      within(screen.getByRole("button", { name: "作品3，画师" }).parentElement as HTMLElement).getByText("2 页"),
    ).toBeTruthy();
  });

  it("安全模式开着时不显示 R-18 作品", async () => {
    const { rerender } = render(<PixivHome safe />);
    await screen.findByRole("button", { name: "作品1，画师" });
    expect(screen.queryByRole("button", { name: "作品2，画师" })).toBeNull();
    rerender(<PixivHome safe={false} />);
    expect(screen.getByRole("button", { name: "作品2，画师" })).toBeTruthy();
  });

  it("点图在墙里原地展开，再点一次或按 Esc 收起；方向键换到同一段的下一张", async () => {
    render(<PixivHome safe={false} />);
    const card = await screen.findByRole("button", { name: "作品1，画师" });
    fireEvent.click(card);
    const band = screen.getByRole("region", { name: "作品1，画师" });
    expect(within(band).getByRole("link", { name: "在 pixiv 打开" }).getAttribute("href")).toBe(
      "https://www.pixiv.net/artworks/1",
    );
    expect(card.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(band, { key: "ArrowRight" });
    expect(screen.getByRole("region", { name: "作品2，画师" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("region", { name: "作品2，画师" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "作品2，画师" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "作品1，画师" }));
    fireEvent.click(screen.getByRole("button", { name: "作品1，画师" }));
    expect(screen.queryByRole("region", { name: "作品1，画师" })).toBeNull();
  });

  it("点大图看全图，读原图；Esc 回到墙", async () => {
    render(<PixivHome safe={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "作品3，画师" }));
    fireEvent.click(screen.getByRole("button", { name: "看全图" }));
    const full = screen.getByRole("group", { name: "第 1 页，共 2 页" });
    expect(full.querySelector("img")?.getAttribute("src")).toContain("img-original/3_p0.png");
    fireEvent.keyDown(full, { key: "ArrowRight" });
    expect(screen.getByRole("group", { name: "第 2 页，共 2 页" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("group", { name: "第 2 页，共 2 页" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: /共 2 页/ })).toBeNull();
  });

  it("滚到墙底附近时读推荐的下一页，读到底就停", async () => {
    render(<PixivHome safe={false} />);
    await screen.findByRole("button", { name: "作品10，画师" });
    const wall = document.querySelector<HTMLElement>(".pw-wall");
    if (!wall) throw new Error("没有墙");
    // 上一页还在读时的滚动不算数，所以一直滚到读满三页，不按固定次数（CI 慢的时候固定四次会少读一页）。
    for (let i = 0; i < 50 && recommendedPages < 3; i++) {
      await act(async () => {
        wall.scrollTop = 100_000;
        fireEvent.scroll(wall);
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(recommendedPages).toBe(3);
    await act(async () => {
      fireEvent.scroll(wall);
    });
    expect(fake.calls("subscription_browse")).toHaveLength(4);
  });

  it("读不了时说明原因，可以重试", async () => {
    fake.on("subscription_browse", () => {
      throw { code: "subscriptionSource", reason: { code: "network" } };
    });
    render(<PixivHome safe={false} />);
    const retry = await screen.findByRole("button", { name: "重试" });
    expect(screen.getByRole("status").textContent).toContain("读取失败");
    fake.on("subscription_browse", { works: [work("5")], next: null });
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "作品5，画师" });
  });
});
