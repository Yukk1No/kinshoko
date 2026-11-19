import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { CollectedWork } from "../bindings/CollectedWork";
import type { PixivWork } from "../bindings/PixivWork";
import type { SaveDestination } from "../bindings/SaveDestination";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { chooseOption } from "../test/select";
import { PixivHome } from "./PixivHome";

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
        : { works: [], next: null },
    subscription_collected: (args) => stored.filter((w) => (args.workIds as string[]).includes(w.workId)),
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
});
afterEach(cleanup);

describe("应用内浏览的收图", () => {
  it("已收的作品带标记，动图没有收图按钮", async () => {
    setup(null);
    renderHome();
    await screen.findByRole("button", { name: "作品1，画师" });
    await waitFor(() => expect(within(card("作品1，画师")).getByText("已收")).toBeTruthy());
    expect(within(card("作品1，画师")).queryByRole("button", { name: /收进图库/ })).toBeNull();
    expect(within(card("作品2，画师")).getByRole("button", { name: "把“作品2”收进图库" })).toBeTruthy();
    expect(within(card("作品4，画师")).queryByRole("button", { name: /收进图库/ })).toBeNull();
  });

  it("记得这个入口上次选的保存目标时，点一次就收进去", async () => {
    setup({ libraryId: "L", folderId: "F" });
    renderHome();
    const collect = await screen.findByRole("button", { name: "把“作品2”收进图库" });
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
    fireEvent.click(await screen.findByRole("button", { name: "把“作品2”收进图库" }));
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
    const collect = await screen.findByRole("button", { name: "把“作品2”收进图库" });
    await waitFor(() => expect(fake.calls("workspace_directories").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(collect);
    expect((await screen.findByRole("alert")).textContent).toContain("没收进图库");
  });
});
