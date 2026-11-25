import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { CollectedWork } from "../bindings/CollectedWork";
import type { HandReport } from "../bindings/HandReport";
import type { PixivWork } from "../bindings/PixivWork";
import type { SaveDestination } from "../bindings/SaveDestination";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { chooseOption } from "../test/select";
import { PixivHome } from "./PixivHome";
import { useCollect } from "./useCollect";

// 应用内浏览的收图（#461 第 3 步）：已收标记、单击就收、第一次先选保存目标、看全图时只收这一页。

function work(id: string, extra: Partial<PixivWork> = {}): PixivWork {
  const page = (p: number) => ({
    preview: `https://i.pximg.net/c/540x540_70/img-master/${id}_p${p}.jpg`,
    large: `https://i.pximg.net/c/600x1200_90/img-master/${id}_p${p}.jpg`,
    original: `https://i.pximg.net/img-original/${id}_p${p}.png`,
  });
  return {
    id,
    kind: "illustration",
    title: `作品${id}`,
    artist: { userId: "9", name: "画师" },
    tags: [],
    explicit: false,
    width: 1000,
    height: 1400,
    pages: [page(0)],
    postedAt: 0,
    bookmarked: false,
    followed: false,
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
    ...extra,
  };
}

const library = { id: "L", name: "参考库", root: "C:/l" };
const libraries = [{ library, unavailable: null }];

let fake: FakeBackend;
let stored: CollectedWork[];
let remembered: SaveDestination | null;

function setup(memory: SaveDestination | null) {
  stored = [{ workId: "1", libraryId: "L", pages: [0] }];
  remembered = memory;
  fake = fakeBackend({
    workspace_directories: {
      status: { revision: "test", libraries },
      registrationOrder: [],
      providers: libraries.map((registration) => ({
        registration,
        sidebar: { all: 0, trash: 0, folders: [{ id: "F", name: "人体", count: 0, children: [] }] },
        unassigned: 0,
        descendants: {},
      })),
    },
    save_memory: () => ({ importDestination: null, newLibraryParent: null, pixivDestination: remembered }),
    remember_pixiv_destination: (args) => {
      remembered = args.destination as SaveDestination;
      return null;
    },
    subscription_browse: (args) =>
      (args.feed as { kind: string }).kind === "following"
        ? {
            works: [
              work("1"),
              work("2"),
              work("3", {
                pages: [
                  work("3").pages[0],
                  { ...work("3").pages[0], original: "https://i.pximg.net/img-original/3_p1.png" },
                ],
              }),
              work("4", { kind: "animation", pages: [{ ...work("4").pages[0], original: null }] }),
            ],
            next: null,
          }
        : (args.feed as { kind: string }).kind === "ranking"
          ? { works: [work("2")], next: null }
          : { works: [], next: null },
    subscription_collected: (args) => stored.filter((w) => (args.workIds as string[]).includes(w.workId)),
    subscription_set_bookmark: null,
    subscription_collect: (args) => {
      const w = args.work as PixivWork;
      const pages = (args.pages as number[] | null) ?? w.pages.map((_, i) => i);
      stored.push({ workId: w.id, libraryId: (args.destination as SaveDestination).libraryId, pages });
      return { collected: pages.length, already: 0, failed: 0, skipped: false };
    },
  });
}

function renderHome() {
  return render(
    <SaveDestinationProvider safe={false}>
      <PixivHome safe={false} />
    </SaveDestinationProvider>,
  );
}

const card = (name: string) => screen.getByRole("button", { name }).parentElement as HTMLElement;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  HTMLElement.prototype.scrollTo = () => {};
});
afterEach(cleanup);

describe("应用内浏览的收图", () => {
  it("已收的作品带标记，动图没有收图按钮", async () => {
    setup(null);
    renderHome();
    await screen.findByRole("button", { name: "作品1，画师" });
    await waitFor(() => expect(within(card("作品1，画师")).getByText("已收")).toBeTruthy());
    expect(within(card("作品1，画师")).queryByRole("button", { name: /^收藏/ })).toBeNull();
    expect(within(card("作品2，画师")).getByRole("button", { name: "收藏“作品2”" })).toBeTruthy();
    expect(within(card("作品4，画师")).queryByRole("button", { name: /^收藏/ })).toBeNull();
  });

  it("在榜单里收了，回到新作时同一个作品也标成已收（几面墙共用一份已收标记）", async () => {
    setup({ libraryId: "L", folderId: "F" });
    renderHome();
    await screen.findByRole("button", { name: "收藏“作品2”" });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(within(screen.getByRole("group", { name: "订阅去处" })).getByRole("button", { name: "榜单" }));
    await screen.findByRole("button", { name: "作品2，画师" });
    fireEvent.click(within(card("作品2，画师")).getByRole("button", { name: "收藏“作品2”" }));
    await waitFor(() => expect(within(card("作品2，画师")).getByText("已收")).toBeTruthy());
    fireEvent.click(within(screen.getByRole("group", { name: "订阅去处" })).getByRole("button", { name: "新作" }));
    expect(within(card("作品2，画师")).getByText("已收")).toBeTruthy();
  });

  it("记得这个入口上次选的保存目标时，点一次就收进去", async () => {
    setup({ libraryId: "L", folderId: "F" });
    renderHome();
    const collect = await screen.findByRole("button", { name: "收藏“作品2”" });
    await waitFor(() => expect(fake.calls("save_memory").length).toBeGreaterThan(0));
    // 等资料库列表读进来，记住的目标才能用。
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(collect);
    await waitFor(() => expect(within(card("作品2，画师")).getByText("已收")).toBeTruthy());
    const call = fake.calls("subscription_collect")[0].args;
    expect(call.destination).toEqual({ libraryId: "L", folderId: "F" });
    expect(call.pages).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("第一次收图时先选保存目标，之后记住它", async () => {
    setup(null);
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "收藏“作品2”" }));
    const dialog = await screen.findByRole("dialog", { name: "收进哪里" });
    await chooseOption(within(dialog).getByRole("combobox", { name: "图库" }), /参考库/);
    fireEvent.click(within(dialog).getByRole("button", { name: "收进图库" }));
    await waitFor(() => expect(within(card("作品2，画师")).getByText("已收")).toBeTruthy());
    expect(remembered).toEqual({ libraryId: "L", folderId: null });
    expect(fake.calls("remember_pixiv_destination")).toHaveLength(1);
  });

  it("收到别处时已收的页也再收一次，好放进新选的位置", async () => {
    setup({ libraryId: "L", folderId: null });
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，画师" }));
    const band = screen.getByRole("region", { name: "作品1，画师" });
    await waitFor(() => expect(within(band).getByRole("button", { name: "再收一次" })).toBeTruthy());
    fireEvent.click(within(band).getByRole("button", { name: "收到别处…" }));
    const dialog = await screen.findByRole("dialog", { name: "收进哪里" });
    await chooseOption(within(dialog).getByRole("combobox", { name: "文件夹" }), /人体/);
    fireEvent.click(within(dialog).getByRole("button", { name: "收进图库" }));
    await waitFor(() => expect(fake.calls("subscription_collect")).toHaveLength(1));
    const call = fake.calls("subscription_collect")[0].args;
    expect(call.again).toBe(true);
    expect(call.destination).toEqual({ libraryId: "L", folderId: "F" });
  });

  it("看全图时可以只收这一页", async () => {
    setup({ libraryId: "L", folderId: null });
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品3，画师" }));
    fireEvent.click(screen.getByRole("button", { name: "看全图" }));
    const full = screen.getByRole("group", { name: "第 1 页，共 2 页" });
    fireEvent.keyDown(full, { key: "ArrowRight" });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(
      within(screen.getByRole("group", { name: "第 2 页，共 2 页" })).getByRole("button", { name: "只收这一页" }),
    );
    await waitFor(() => expect(fake.calls("subscription_collect")).toHaveLength(1));
    expect(fake.calls("subscription_collect")[0].args.pages).toEqual([1]);
    // 收这一页不会关掉全图。
    expect(screen.getByRole("group", { name: "第 2 页，共 2 页" })).toBeTruthy();
    await waitFor(() =>
      expect(within(screen.getByRole("group", { name: "第 2 页，共 2 页" })).getByText("已收")).toBeTruthy(),
    );
  });

  it("收不进时说明原因", async () => {
    setup({ libraryId: "L", folderId: null });
    fake.on("subscription_collect", () => {
      throw { code: "subscriptionSource", reason: { code: "network" } };
    });
    renderHome();
    const collect = await screen.findByRole("button", { name: "收藏“作品2”" });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(collect);
    expect((await screen.findByRole("alert")).textContent).toContain("无法收进图库");
  });

  it("“收藏”一次就写 pixiv 收藏并收进图库；R-18 作品收成非公开", async () => {
    setup({ libraryId: "L", folderId: null });
    fake.on("subscription_browse", (args: { feed?: unknown }) =>
      (args.feed as { kind: string }).kind === "following"
        ? { works: [work("2"), work("5", { explicit: true })], next: null }
        : { works: [], next: null },
    );
    renderHome();
    await screen.findByRole("button", { name: "收藏“作品2”" });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole("button", { name: "收藏“作品2”" }));
    await waitFor(() => expect(within(card("作品2，画师")).getByText("已收")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "收藏“作品5”" }));
    await waitFor(() => expect(within(card("作品5，画师")).getByText("已收")).toBeTruthy());
    expect(fake.calls("subscription_set_bookmark").map((c) => c.args)).toEqual([
      { illustId: "2", on: true, private: false },
      { illustId: "5", on: true, private: true },
    ]);
    expect(fake.calls("subscription_collect").map((c) => (c.args.work as PixivWork).id)).toEqual(["2", "5"]);
  });

  it("第一次收藏时在保存目标对话框里取消，pixiv 收藏也不写", async () => {
    setup(null);
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "收藏“作品2”" }));
    const dialog = await screen.findByRole("dialog", { name: "收进哪里" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.calls("subscription_set_bookmark")).toHaveLength(0);
    expect(fake.calls("subscription_collect")).toHaveLength(0);
  });

  it("取消 pixiv 收藏不动图库里的图；写失败时改回来并说明", async () => {
    setup({ libraryId: "L", folderId: null });
    fake.on("subscription_browse", (args: { feed?: unknown }) =>
      (args.feed as { kind: string }).kind === "following"
        ? { works: [work("1", { bookmarked: true })], next: null }
        : { works: [], next: null },
    );
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，画师" }));
    const band = screen.getByRole("region", { name: "作品1，画师" });
    await waitFor(() => expect(within(band).getByText("已收藏")).toBeTruthy());
    fireEvent.click(within(band).getByRole("button", { name: "取消 pixiv 收藏" }));
    await waitFor(() => expect(fake.calls("subscription_set_bookmark")).toHaveLength(1));
    expect(fake.calls("subscription_set_bookmark")[0].args).toEqual({ illustId: "1", on: false, private: false });
    // 没收藏了，又能点“收藏”；图库里那张还在（已收、再收一次）。
    expect(within(band).getByRole("button", { name: "收藏" })).toBeTruthy();
    expect(within(band).getByRole("button", { name: "再收一次" })).toBeTruthy();

    fake.on("subscription_set_bookmark", () => {
      throw { code: "subscriptionSource", reason: { code: "network" } };
    });
    fireEvent.click(within(band).getByRole("button", { name: "收藏" }));
    expect((await screen.findByRole("alert")).textContent).toContain("无法加入 pixiv 收藏");
    await waitFor(() => expect(within(band).queryByRole("button", { name: "取消 pixiv 收藏" })).toBeNull());
  });

  it("取消 pixiv 收藏还在写时，“收藏”不能点", async () => {
    setup({ libraryId: "L", folderId: null });
    fake.on("subscription_browse", (args: { feed?: unknown }) =>
      (args.feed as { kind: string }).kind === "following"
        ? { works: [work("1", { bookmarked: true })], next: null }
        : { works: [], next: null },
    );
    fake.on("subscription_set_bookmark", () => new Promise(() => {}));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "作品1，画师" }));
    const band = screen.getByRole("region", { name: "作品1，画师" });
    await waitFor(() => expect(within(band).getByText("已收藏")).toBeTruthy());
    fireEvent.click(within(band).getByRole("button", { name: "取消 pixiv 收藏" }));
    expect(within(band).getByRole("button", { name: "收藏" })).toHaveProperty("disabled", true);
  });

  it("同一作品同步连续点击收藏不并发重复收图；乱序 refresh 不覆写最新已收标记（#716）", async () => {
    setup({ libraryId: "L", folderId: "F" });
    let finishCollect: () => void = () => {};
    fake.on(
      "subscription_collect",
      () =>
        new Promise<HandReport>((resolve) => {
          finishCollect = () => resolve({ collected: 1, already: 0, failed: 0, skipped: false });
        }),
    );
    const { result } = renderHook(() => useCollect([], null), {
      wrapper: ({ children }) => <SaveDestinationProvider safe={false}>{children}</SaveDestinationProvider>,
    });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));

    const w2 = work("2");
    act(() => {
      result.current.collect(w2);
      result.current.collect(w2);
    });
    await waitFor(() => expect(fake.calls("subscription_collect")).toHaveLength(1));

    // 在收图完成后的刷新前先制造一个迟到的旧 subscription_collected 响应，不应覆写最新状态。
    const collectedReplies: Array<(rows: CollectedWork[]) => void> = [];
    fake.on(
      "subscription_collected",
      () =>
        new Promise<CollectedWork[]>((resolve) => {
          collectedReplies.push(resolve);
        }),
    );
    act(() => {
      result.current.track([work("2")]);
    });
    await act(async () => {
      finishCollect();
      await Promise.resolve();
    });
    await waitFor(() => expect(collectedReplies).toHaveLength(2));
    // 先让后发的（含已收）返回，再让先发的（未收空列表）迟到返回。
    await act(async () => {
      collectedReplies[1]([{ workId: "2", libraryId: "L", pages: [0] }]);
      await Promise.resolve();
    });
    await act(async () => {
      collectedReplies[0]([]);
      await Promise.resolve();
    });
    expect(result.current.collected.get("2")?.has(0)).toBe(true);
  });

  it("组件卸载后收图收尾不再补发已收查询（#716）", async () => {
    setup({ libraryId: "L", folderId: "F" });
    let finishCollect: () => void = () => {};
    fake.on(
      "subscription_collect",
      () =>
        new Promise<HandReport>((resolve) => {
          finishCollect = () => resolve({ collected: 1, already: 0, failed: 0, skipped: false });
        }),
    );
    const { result, unmount } = renderHook(() => useCollect([], null), {
      wrapper: ({ children }) => <SaveDestinationProvider safe={false}>{children}</SaveDestinationProvider>,
    });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));

    act(() => {
      result.current.collect(work("2"));
    });
    await waitFor(() => expect(fake.calls("subscription_collect")).toHaveLength(1));
    const before = fake.calls("subscription_collected").length;
    unmount();
    await act(async () => {
      finishCollect();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(fake.calls("subscription_collected")).toHaveLength(before);
  });
});
