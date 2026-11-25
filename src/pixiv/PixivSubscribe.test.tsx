import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { tipText } from "../test/tip";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { PixivWork } from "../bindings/PixivWork";
import type { Subscription } from "../bindings/Subscription";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { ToastProvider } from "../ui/Toast";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { PixivHome } from "./PixivHome";

// 订阅管理（#461 第 6、7 步）：关注即订阅，榜单与收藏夹的就地开关和收进的库，画师页的卡片、批量改库与退订。几处改的是同一份名单。

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
      subscriptionDestination: null,
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
    subscription_previews: [],
    subscription_old_images: [],
    subscription_move_old: { moved: 0, kept: 0, works: [] },
    subscription_undo_move: null,
    subscription_set_library: (args) => {
      const ids = args.ids as string[];
      list = list.map((s) => (ids.includes(s.id) ? { ...s, libraryId: args.libraryId as string } : s));
      return list.filter((s) => ids.includes(s.id));
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
  it("榜单页顶上“自动收日榜”订阅全年龄日榜前 50；打开后旁边写着收进哪个库，点开能换", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "改收进的库，现在收进「pixiv」" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "参考库" }));
    await waitFor(() => expect(fake.calls("subscription_set_library")).toHaveLength(1));
    expect(fake.calls("subscription_set_library")[0].args).toEqual({ ids: ["new-1"], libraryId: "L" });
    await screen.findByRole("button", { name: "改收进的库，现在收进「参考库」" });
    // 已收的图不搬：提示里说清楚；能撤销。
    await screen.findByText("日榜 前 50 以后收进「参考库」，已收的图留在「pixiv」");
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(fake.calls("subscription_set_library")).toHaveLength(2));
    expect(fake.calls("subscription_set_library")[1].args).toEqual({ ids: ["new-1"], libraryId: "P" });
    await screen.findByRole("button", { name: "改收进的库，现在收进「pixiv」" });
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

const kobayashi = () => ({
  ...list[0],
  id: "s-77",
  name: "小林",
  target: { kind: "pixivArtist" as const, userId: "77" },
});

async function artistCards() {
  fireEvent.click(place("画师"));
  return screen.findByRole("list", { name: "画师" });
}

async function openMore(name: string) {
  fireEvent.click(
    within(await screen.findByRole("list", { name: "画师" })).getByRole("button", { name: `更多操作：${name}` }),
  );
  return screen.findByRole("menu", { name: `更多操作：${name}` });
}

describe("画师页", () => {
  it("卡片上是收过的图、名字、多久没有新图、收进哪个库", async () => {
    const day = 24 * 60 * 60 * 1000;
    fake.on("subscription_previews", () => [
      {
        subscriptionId: "s-2",
        received: 12,
        lastReceivedAt: Date.now() - 3 * day,
        images: [{ libraryId: "L", imageId: "i1", explicit: false }],
      },
    ]);
    renderHome();
    const cards = await artistCards();
    const card = within(cards).getByText("山田").closest("li") as HTMLElement;
    await within(card).findByText("3 天前有新图");
    expect(card.querySelector(".pw-artist-library")?.textContent).toBe("新作收进参考库");
    await waitFor(() => expect(card.querySelectorAll("img")).toHaveLength(1));
    // 点缩略图看这位画师的作品。
    fireEvent.click(within(card).getByRole("button", { name: "看 山田 的作品" }));
    expect(await screen.findByRole("button", { name: "全部画师" })).toBeTruthy();
    // 作品页上也看得到订阅着、收进哪个库。
    expect(screen.getByRole("button", { name: "改收进的库，现在收进「参考库」" })).toBeTruthy();
  });

  it("后台检查结束后重读名单：上次检查没完成的画师卡片上写出来，原因在悬停提示里", async () => {
    renderHome();
    const cards = await artistCards();
    const card = () => within(cards).getByText("山田").closest("li") as HTMLElement;
    expect(within(card()).queryByText("上次检查未完成")).toBeNull();
    list = list.map((s) => ({ ...s, lastError: { code: "rateLimited" }, lastFailedAt: Date.now() }));
    const status = { enabled: true, login: { state: "loggedIn", account: { userId: "1", name: "me" } }, newCount: 0 };
    await act(() => emit("subscription-status", { ...status, checking: true }));
    await act(() => emit("subscription-status", { ...status, checking: false }));
    const warn = await within(card()).findByText("上次检查未完成");
    expect(await tipText(warn)).toBe("上次检查未完成：pixiv 限制了请求次数");
  });

  it("⋯ 里“在 pixiv 上取消关注”取消关注并退订；撤销重新关注，照原来的库与收取范围", async () => {
    list = [{ ...list[0], includeManga: true, includeExplicit: false }];
    renderHome();
    await artistCards();
    fireEvent.click(within(await openMore("山田")).getByRole("menuitem", { name: "在 pixiv 上取消关注，不再自动收" }));
    await waitFor(() => expect(fake.calls("subscription_remove")).toHaveLength(1));
    expect(fake.calls("subscription_set_follow")[0].args).toEqual({ userId: "2", on: false });
    expect(await screen.findByText("还没有订阅画师")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(fake.calls("subscription_add")).toHaveLength(1));
    expect(fake.calls("subscription_set_follow")[1].args).toEqual({ userId: "2", on: true });
    const [back] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(back).toMatchObject({ libraryId: "L", includeManga: true, includeExplicit: false });
    expect(within(await screen.findByRole("list", { name: "画师" })).getByText("山田")).toBeTruthy();
    // 订回来了，不再算“已取消订阅的”。
    expect(screen.queryByText("山田 已取消订阅")).toBeNull();
  });

  it("⋯ 里取消订阅只退订，不动 pixiv 上的关注；退订的能在“已取消订阅的”里找回", async () => {
    list = [...list, kobayashi()];
    renderHome();
    await artistCards();
    fireEvent.click(within(await openMore("山田")).getByRole("menuitem", { name: "取消订阅（pixiv 上仍关注）" }));
    await screen.findByText("不再自动收 山田，pixiv 上仍关注");
    expect(fake.calls("subscription_remove")[0].args).toEqual({ id: "s-2" });
    expect(fake.calls("subscription_set_follow")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "已取消订阅 1 位" }));
    const gone = await screen.findByRole("list", { name: "画师" });
    expect(within(gone).queryByText("小林")).toBeNull();
    fireEvent.click(within(gone).getByRole("button", { name: "重新订阅" }));
    await waitFor(() => expect(fake.calls("subscription_add")).toHaveLength(1));
    const [back] = fake.calls("subscription_add")[0].args.subscriptions as NewSubscription[];
    expect(back).toMatchObject({
      target: { kind: "pixivArtist", userId: "2" },
      libraryId: "L",
      backlog: { kind: "newOnly" },
    });
    await screen.findByText("已重新订阅 山田，只收之后的新作");
    // 最后一位也订回来了：回到全部画师。
    expect(within(await screen.findByRole("list", { name: "画师" })).getByText("山田")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已取消订阅 1 位" })).toBeNull();
  });

  it("搜索时，名字对得上的已取消订阅的画师列在下面，能重新订阅", async () => {
    list = [...list, kobayashi()];
    renderHome();
    await artistCards();
    fireEvent.click(within(await openMore("山田")).getByRole("menuitem", { name: "取消订阅（pixiv 上仍关注）" }));
    await screen.findByText("不再自动收 山田，pixiv 上仍关注");
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索" }), { target: { value: "山" } });
    const matches = await screen.findByRole("list", { name: "已取消订阅的画师" });
    expect(within(matches).getByText("山田 已取消订阅")).toBeTruthy();
    fireEvent.click(within(matches).getByRole("button", { name: "重新订阅" }));
    await waitFor(() => expect(fake.calls("subscription_add")).toHaveLength(1));
  });

  it("选择、全选后一起改收进的库；提示说已收的图留在原处，撤销改回原来的库", async () => {
    list = [...list, { ...kobayashi(), libraryId: "P" }];
    renderHome();
    await artistCards();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "全选这 2 位" }));
    const bar = screen.getByRole("toolbar", { name: "已选 2 位" });
    fireEvent.click(within(bar).getByRole("button", { name: "改收进的库" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "pixiv" }));
    // 已经收进 pixiv 的小林不用改。
    await waitFor(() => expect(fake.calls("subscription_set_library")).toHaveLength(1));
    expect(fake.calls("subscription_set_library")[0].args).toEqual({ ids: ["s-2"], libraryId: "P" });
    await screen.findByText("山田 以后收进「pixiv」，已收的图留在「参考库」");
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(fake.calls("subscription_set_library")).toHaveLength(2));
    expect(fake.calls("subscription_set_library")[1].args).toEqual({ ids: ["s-2"], libraryId: "L" });
  });

  it("改收进的库时已收的图默认一起移过去；提示上“留在「旧库」”把图移回去", async () => {
    const works = [
      {
        subscriptionId: "s-2",
        source: "pixiv",
        workId: "9",
        fromLibraryId: "L",
        toLibraryId: "P",
        pages: [{ page: 0, fromImageId: "a", toImageId: "b", created: true }],
      },
    ];
    fake.on("subscription_move_old", () => ({ moved: 3, kept: 1, works }));
    renderHome();
    await artistCards();
    const menu = await openMore("山田");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /改收进的库/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "pixiv" }));
    await waitFor(() => expect(fake.calls("subscription_move_old")).toHaveLength(1));
    expect(fake.calls("subscription_move_old")[0].args).toEqual({ ids: ["s-2"] });
    await screen.findByText("山田 以后收进「pixiv」，已收的 3 张也移过去了");
    fireEvent.click(await screen.findByRole("button", { name: "留在「参考库」" }));
    await waitFor(() => expect(fake.calls("subscription_undo_move")).toHaveLength(1));
    expect(fake.calls("subscription_undo_move")[0].args).toEqual({ works });
    // 只把图移回去，以后还是收进 pixiv。
    expect(fake.calls("subscription_set_library")).toHaveLength(1);
  });

  it("还有图留在旧库时卡片上写着在哪、有几张；“移过来”移完能撤销", async () => {
    list = [{ ...list[0], libraryId: "P" }];
    fake.on("subscription_old_images", () => [{ subscriptionId: "s-2", libraryId: "L", movable: 2, kept: 0 }]);
    fake.on("subscription_move_old", () => ({ moved: 2, kept: 0, works: [] }));
    renderHome();
    const cards = await artistCards();
    const card = within(cards).getByText("山田").closest("li") as HTMLElement;
    await waitFor(() => expect(card.querySelector(".pw-artist-old")?.textContent).toBe("已收的 2 张还在参考库移过来"));
    fake.on("subscription_old_images", () => []);
    fireEvent.click(within(card).getByRole("button", { name: "把 山田 已收的 2 张移到「pixiv」" }));
    await screen.findByText("已把 2 张移到「pixiv」");
    await waitFor(() => expect(card.querySelector(".pw-artist-old")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(fake.calls("subscription_undo_move")).toHaveLength(1));
  });

  it("一起改到新建的图库", async () => {
    list = [...list, kobayashi()];
    renderHome();
    await artistCards();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 山田" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 小林" }));
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "已选 2 位" })).getByRole("button", { name: "改收进的库" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "新建图库…" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("选几位一起取消订阅：一条提示，撤销一起订回来", async () => {
    list = [...list, kobayashi()];
    renderHome();
    await artistCards();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "全选这 2 位" }));
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "已选 2 位" })).getByRole("button", { name: "取消订阅" }),
    );
    await screen.findByText("已取消订阅 2 位画师，pixiv 上仍关注");
    expect(fake.calls("subscription_remove")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(fake.calls("subscription_add")).toHaveLength(1));
    expect(fake.calls("subscription_add")[0].args.subscriptions).toHaveLength(2);
  });

  it("墙上正在关注一位画师时，他的卡片上不能退订", async () => {
    list = [...list, kobayashi()];
    fake.on("subscription_set_follow", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    const follow = within(band).getByRole("button", { name: "关注" });
    await waitFor(() => expect(follow).toHaveProperty("disabled", false));
    fireEvent.click(follow);
    await artistCards();
    const menu = await openMore("小林");
    expect(
      within(menu).getByRole("menuitem", { name: "取消订阅（pixiv 上仍关注）" }).hasAttribute("data-disabled"),
    ).toBe(true);
  });

  it("墙上正在关注一位画师时，选中他就不能批量改库或退订", async () => {
    list = [...list, kobayashi()];
    fake.on("subscription_set_follow", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    const follow = within(band).getByRole("button", { name: "关注" });
    await waitFor(() => expect(follow).toHaveProperty("disabled", false));
    fireEvent.click(follow);
    await artistCards();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 小林" }));
    const bar = screen.getByRole("toolbar", { name: "已选 1 位" });
    expect(within(bar).getByRole("button", { name: "取消订阅" })).toHaveProperty("disabled", true);
    expect(within(bar).getByRole("button", { name: "改收进的库" })).toHaveProperty("disabled", true);
  });

  it("画师页正在退订一位画师时，墙上不能关注他", async () => {
    list = [...list, kobayashi()];
    fake.on("subscription_remove", () => new Promise(() => {}));
    renderHome();
    await artistCards();
    fireEvent.click(within(await openMore("小林")).getByRole("menuitem", { name: "取消订阅（pixiv 上仍关注）" }));
    fireEvent.click(place("新作"));
    fireEvent.click(await screen.findByRole("button", { name: "作品1，小林" }));
    const band = screen.getByRole("region", { name: "作品1，小林" });
    expect(within(band).getByRole("button", { name: "关注" })).toHaveProperty("disabled", true);
  });

  it("画师页能订阅画师、从关注导入", async () => {
    renderHome();
    await artistCards();
    const add = await screen.findByRole("button", { name: "订阅画师" });
    await waitFor(() => expect(add).toHaveProperty("disabled", false));
    fireEvent.click(add);
    expect(await screen.findByRole("dialog", { name: "订阅画师" })).toBeTruthy();
  });
});
