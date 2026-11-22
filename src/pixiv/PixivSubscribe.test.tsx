import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { PixivWork } from "../bindings/PixivWork";
import type { Subscription } from "../bindings/Subscription";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { ToastProvider } from "../ui/Toast";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { PixivHome } from "./PixivHome";

// 订阅管理（#461 第 6 步）：关注即订阅，榜单与收藏夹的就地开关，画师卡片的 ⋯，第六项“管理”。几处改的是同一份名单。

function work(id: string, artist = { userId: "77", name: "小林" }): PixivWork {
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

const libraries = [
  { library: { id: "L", name: "参考库", root: "C:/l" }, unavailable: null },
  { library: { id: "P", name: "pixiv", root: "C:/p" }, unavailable: null },
];

function stored(s: NewSubscription, id: string): Subscription {
  return {
    id,
    target: s.target,
    name: s.name,
    libraryId: s.libraryId,
    includeExplicit: s.includeExplicit,
    includeManga: s.includeManga,
    backlog: s.backlog,
    since: null,
    skipped: 0,
    createdAt: 0,
    lastCheckedAt: null,
    lastError: null,
    lastFailedAt: null,
  } as Subscription;
}

let fake: FakeBackend;
let list: Subscription[];

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  HTMLElement.prototype.scrollTo = () => {};
  mockConvertFileSrc("windows");
  list = [
    stored(
      {
        target: { kind: "pixivArtist", userId: "2" },
        name: "山田",
        libraryId: "L",
        includeExplicit: true,
        includeManga: false,
        backlog: { kind: "newOnly" },
      },
      "s-2",
    ),
  ];
  let next = 0;
  fake = fakeBackend({
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
    // 这个入口上次亲手选的收图目标是 pixiv 库。
    save_memory: {
      importDestination: null,
      newLibraryParent: null,
      pixivDestination: { libraryId: "P", folderId: null },
    },
    subscriptions: () => list,
    subscription_status: {
      enabled: true,
      login: { state: "loggedIn", account: { userId: "1", name: "me", explicit: true } },
      checking: false,
      newCount: 0,
    },
    subscription_browse: (args) => {
      const feed = args.feed as { kind: string };
      if (feed.kind === "following") return { works: [work("1")], next: null };
      return { works: [], next: null };
    },
    subscription_collected: [],
    subscription_set_follow: null,
    subscription_add: (args) => {
      const added = (args.subscriptions as NewSubscription[]).map((s) => stored(s, `new-${++next}`));
      list = [...list, ...added];
      return added;
    },
    subscription_remove: (args) => {
      list = list.filter((s) => s.id !== args.id);
      return null;
    },
  });
});
afterEach(cleanup);

function renderHome() {
  return render(
    <ToastProvider>
      <SaveDestinationProvider safe={false}>
        <PixivHome safe={false} />
      </SaveDestinationProvider>
    </ToastProvider>,
  );
}

const place = (name: string) =>
  within(screen.getByRole("group", { name: "订阅去处" })).getByRole("button", { name: new RegExp(`^${name}$`) });

describe("关注即订阅", () => {
  it("展开的一格里关注：pixiv 上关注，同时订阅这位画师（只收新作，和已订阅的画师收进同一个库）；取消关注同时退订", async () => {
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    fireEvent.click(within(band).getByRole("button", { name: "关注" }));
    await within(band).findByRole("button", { name: "已关注，自动收" });
    expect(fake.calls("subscription_set_follow")[0].args).toEqual({ userId: "77", on: true });
    const [added] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(added).toMatchObject({
      target: { kind: "pixivArtist", userId: "77" },
      name: "小林",
      libraryId: "L",
      backlog: { kind: "newOnly" },
    });

    // 画师页里跟着出现。
    fireEvent.click(place("画师"));
    expect(within(await screen.findByRole("list", { name: "画师" })).getByText("小林")).toBeTruthy();

    fireEvent.click(place("新作"));
    fireEvent.click(within(band).getByRole("button", { name: "已关注，自动收" }));
    await within(band).findByRole("button", { name: "关注" });
    expect(fake.calls("subscription_set_follow")[1].args).toEqual({ userId: "77", on: false });
    expect(fake.calls("subscription_remove")[0].args).toEqual({ id: "new-1" });
  });

  it("取消关注时退订写完之前按钮一直锁着，不会关注了却没订阅", async () => {
    let finish: () => void = () => {};
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    fireEvent.click(within(band).getByRole("button", { name: "关注" }));
    const followed = await within(band).findByRole("button", { name: "已关注，自动收" });
    await waitFor(() => expect(followed).toHaveProperty("disabled", false));
    fake.on(
      "subscription_remove",
      () =>
        new Promise<unknown>((resolve) => {
          finish = () => {
            list = list.filter((s) => s.id !== "new-1");
            resolve(null);
          };
        }),
    );
    fireEvent.click(followed);
    await waitFor(() => expect(fake.calls("subscription_remove")).toHaveLength(1));
    expect(within(band).getByRole("button", { name: /关注/ })).toHaveProperty("disabled", true);
    finish();
    await waitFor(() => expect(within(band).getByRole("button", { name: "关注" })).toHaveProperty("disabled", false));
  });

  it("订阅名单还没读到时关注按钮不能点", async () => {
    fake.on("subscriptions", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    expect(within(band).getByRole("button", { name: "关注" })).toHaveProperty("disabled", true);
  });

  it("资料库还没读到时关注按钮不能点（否则会当成没有资料库而只关注不订阅）", async () => {
    fake.on("workspace_directories", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    await waitFor(() => expect(fake.calls("subscriptions")).toHaveLength(1));
    expect(within(band).getByRole("button", { name: "关注" })).toHaveProperty("disabled", true);
  });

  it("pixiv 上没关注成时不订阅", async () => {
    fake.on("subscription_set_follow", () => {
      throw { code: "subscriptionSource", reason: { code: "network" } };
    });
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    fireEvent.click(within(band).getByRole("button", { name: "关注" }));
    await within(band).findByRole("button", { name: "关注" });
    expect(fake.calls("subscription_add")).toHaveLength(0);
  });
});

describe("就地开关", () => {
  it("榜单页顶上“自动收日榜”订阅全年龄日榜前 50；“管理”里的开关跟着变", async () => {
    renderHome();
    fireEvent.click(place("榜单"));
    const toggle = await screen.findByRole("switch", { name: "自动收日榜" });
    await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    const [added] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(added.target).toEqual({ kind: "pixivRanking", period: "day", top: 50, explicit: false });
    // 还没有订阅榜单：收进这个入口上次亲手选的库。
    expect(added.libraryId).toBe("P");

    fireEvent.click(place("管理"));
    const manageDay = await screen.findByRole("switch", { name: "自动收日榜" });
    expect(manageDay.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(manageDay);
    await waitFor(() => expect(fake.calls("subscription_remove")).toHaveLength(1));
    fireEvent.click(place("榜单"));
    expect((await screen.findByRole("switch", { name: "自动收日榜" })).getAttribute("aria-checked")).toBe("false");
  });

  it("我的收藏页一个开关：公开和非公开收藏一起同步，只收之后新收藏的", async () => {
    renderHome();
    fireEvent.click(place("我的收藏"));
    const toggle = await screen.findByRole("switch", { name: "同步收藏到图库" });
    await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(fake.calls("subscription_add")).toHaveLength(1));
    const [added] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(added).toMatchObject({
      target: { kind: "pixivBookmarks" },
      backlog: { kind: "newOnly" },
      privateBacklog: { kind: "newOnly" },
    });

    // 关掉可以撤销：按原来的库重新订阅，公开和非公开都只收之后的新收藏。
    fireEvent.click(toggle);
    await waitFor(() => expect(fake.calls("subscription_remove")).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    const [back] = fake.calls("subscription_add")[1].args.subscriptions as NewSubscription[];
    expect(back).toMatchObject({
      target: { kind: "pixivBookmarks" },
      libraryId: added.libraryId,
      privateBacklog: { kind: "newOnly" },
    });
  });

  it("关掉榜单开关可以撤销，撤销前又打开了就不再加一条", async () => {
    renderHome();
    fireEvent.click(place("榜单"));
    const toggle = await screen.findByRole("switch", { name: "自动收日榜" });
    await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    const undo = await screen.findByRole("button", { name: "撤销" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(undo);
    await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
    expect(fake.calls("subscription_add")).toHaveLength(2);
  });
});

describe("画师卡片与“管理”", () => {
  it("画师卡片的 ⋯ 写着收进哪个库；“取消关注”在 pixiv 上取消关注并退订", async () => {
    list = [{ ...list[0], includeManga: true, includeExplicit: false }];
    renderHome();
    fireEvent.click(place("画师"));
    const cards = await screen.findByRole("list", { name: "画师" });
    fireEvent.click(within(cards).getByRole("button", { name: "更多操作：山田" }));
    expect(await screen.findByText("新作收进「参考库」")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "在 pixiv 上取消关注，不再自动收" }));
    await waitFor(() => expect(fake.calls("subscription_remove")).toHaveLength(1));
    expect(fake.calls("subscription_set_follow")[0].args).toEqual({ userId: "2", on: false });
    expect(await screen.findByText("还没有订阅画师")).toBeTruthy();
    // 撤销就是重新关注，也就重新订阅。
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(fake.calls("subscription_add")).toHaveLength(1));
    expect(fake.calls("subscription_set_follow")[1].args).toEqual({ userId: "2", on: true });
    // 照原来那条订阅的库与收取范围。
    const [back] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(back).toMatchObject({ libraryId: "L", includeManga: true, includeExplicit: false });
    expect(within(await screen.findByRole("list", { name: "画师" })).getByText("山田")).toBeTruthy();
  });

  it("“管理”里取消订阅只退订，不动 pixiv 上的关注", async () => {
    renderHome();
    fireEvent.click(place("管理"));
    const artists = await screen.findByRole("list", { name: "画师" });
    expect(within(artists).getByText("收进「参考库」")).toBeTruthy();
    fireEvent.click(within(artists).getByRole("button", { name: "取消订阅 山田" }));
    await screen.findByText("还没有订阅的画师");
    expect(fake.calls("subscription_remove")[0].args).toEqual({ id: "s-2" });
    expect(fake.calls("subscription_set_follow")).toHaveLength(0);
    // 能撤销的不先确认：做完给带“撤销”的轻提示（说清 pixiv 上还关注着），撤销按原来的库重新订阅，只收之后的新作。
    await screen.findByText("不再自动收 山田，pixiv 上仍关注");
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await within(artists).findByText("山田");
    const [back] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(back).toMatchObject({
      target: { kind: "pixivArtist", userId: "2" },
      libraryId: "L",
      backlog: { kind: "newOnly" },
    });
  });

  it("墙上正在关注一位画师时，“管理”里不能退订他", async () => {
    list = [...list, { ...list[0], id: "s-77", name: "小林", target: { kind: "pixivArtist", userId: "77" } }];
    fake.on("subscription_set_follow", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    const follow = within(band).getByRole("button", { name: "关注" });
    await waitFor(() => expect(follow).toHaveProperty("disabled", false));
    fireEvent.click(follow);
    fireEvent.click(place("管理"));
    const artists = await screen.findByRole("list", { name: "画师" });
    expect(within(artists).getByRole("button", { name: "取消订阅 小林" })).toHaveProperty("disabled", true);
    expect(within(artists).getByRole("button", { name: "取消订阅 山田" })).toHaveProperty("disabled", false);
  });

  it("“管理”里正在退订一位画师时，墙上不能关注他", async () => {
    list = [...list, { ...list[0], id: "s-77", name: "小林", target: { kind: "pixivArtist", userId: "77" } }];
    fake.on("subscription_remove", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(place("管理"));
    const artists = await screen.findByRole("list", { name: "画师" });
    fireEvent.click(within(artists).getByRole("button", { name: "取消订阅 小林" }));
    fireEvent.click(place("新作"));
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    expect(within(band).getByRole("button", { name: "关注" })).toHaveProperty("disabled", true);
  });

  it("“管理”里能订阅画师、从关注导入", async () => {
    renderHome();
    fireEvent.click(place("管理"));
    const add = await screen.findByRole("button", { name: "订阅画师" });
    await waitFor(() => expect(add).toHaveProperty("disabled", false));
    fireEvent.click(add);
    expect(await screen.findByRole("dialog", { name: "订阅画师" })).toBeTruthy();
  });
});
