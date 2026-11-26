import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { PixivWork } from "../bindings/PixivWork";
import type { Subscription } from "../bindings/Subscription";
import { SaveDestinationProvider } from "../library/SaveDestination";
import { ToastProvider } from "../ui/Toast";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { PixivHome } from "./PixivHome";

// 订阅名单共享镜像（#741）在订阅页的交错竞态：检查引发的旧读取不能盖掉先完成的退订。

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

describe("订阅页共享镜像的交错竞态", () => {
  it("重读先发出、退订先完成时，旧名单后返回也不把画师放回来", async () => {
    let reads = 0;
    let releaseOldRead: (() => void) | null = null;
    fake.on("subscriptions", () => {
      reads++;
      if (reads === 2) {
        const old = list;
        return new Promise<Subscription[]>((resolve) => {
          releaseOldRead = () => resolve(old);
        });
      }
      return list;
    });
    renderHome();
    const cards = await artistCards();
    expect(within(cards).getByRole("button", { name: "看 山田 的作品" })).toBeTruthy();

    const status = { enabled: true, login: { state: "loggedIn", account: { userId: "1", name: "me" } }, newCount: 0 };
    await act(() => emit("subscription-status", { ...status, checking: true }));
    await waitFor(() => expect(fake.calls("subscriptions")).toHaveLength(2));
    fireEvent.click(within(await openMore("山田")).getByRole("menuitem", { name: "取消订阅（pixiv 上仍关注）" }));
    await screen.findByText("不再自动收 山田，pixiv 上仍关注");
    expect(fake.calls("subscription_remove")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "看 山田 的作品" })).toBeNull();

    await act(async () => releaseOldRead!());
    expect(screen.queryByRole("button", { name: "看 山田 的作品" })).toBeNull();
  });
});
