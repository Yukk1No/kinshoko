import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`,
}));

const { pixivImageSrc, subscriptionBrowse, subscriptionSearchArtists } = await import("./pixivBrowse");

describe("pixiv 应用内浏览的接口", () => {
  beforeEach(() => invoke.mockReset());

  it("第一页不带 next，之后原样交回", async () => {
    invoke.mockResolvedValue({ works: [], next: null });
    await subscriptionBrowse({ kind: "following" });
    await subscriptionBrowse({ kind: "ranking", period: "week", explicit: false }, "https://app-api.pixiv.net/x");
    expect(invoke.mock.calls).toEqual([
      ["subscription_browse", { feed: { kind: "following" }, next: null }],
      [
        "subscription_browse",
        { feed: { kind: "ranking", period: "week", explicit: false }, next: "https://app-api.pixiv.net/x" },
      ],
    ]);
    await subscriptionSearchArtists("画师");
    expect(invoke).toHaveBeenLastCalledWith("subscription_search_artists", { word: "画师", next: null });
  });

  it("只把 pixiv 图片主机上的地址换成转发地址", () => {
    expect(pixivImageSrc("https://i.pximg.net/c/540x540_70/img-master/5_p0.jpg")).toBe(
      "http://pximg.localhost/c/540x540_70/img-master/5_p0.jpg",
    );
    expect(pixivImageSrc("https://example.com/a.jpg")).toBeNull();
  });
});
