// 图片墙只经工作区浏览分页（#363）：范围、查找条件与安全模式随每一页的查询一起传；
// 重新浏览取到一半游标过期时从第一页重取。IPC 用受控 Promise 决定响应先后。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceQuery } from "../bindings/WorkspaceQuery";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { type CardSeed, workspacePage } from "../test/workspacePage";
import { Wall, type WallHandle } from "./Wall";
import { PAGE, type BrowsePageDelivery, type BrowsePager } from "./wallShared";
import { fakeBackend } from "../test/backend";

type Call = {
  query: WorkspaceQuery;
  safeMode: boolean;
  resolve: (page: WorkspacePage) => void;
  reject: (e: unknown) => void;
};
let calls: Call[];

beforeEach(() => {
  calls = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  fakeBackend({
    workspace_browse: (args) => {
      return new Promise<WorkspacePage>((resolve, reject) => {
        calls.push({ ...(args as { query: WorkspaceQuery; safeMode: boolean }), resolve, reject });
      });
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const EXPIRED = { code: "cursorExpired" };
const EXPIRED_TEXT = "浏览结果已变化，请从头重新浏览";
const card = (id: string): CardSeed => ({ id, width: 100, height: 100 });
const folder: WorkspaceScope = { kind: "library", libraryId: "L2", scope: { kind: "folder", id: "F" } };
const tree: ConditionTree = {
  conditions: [{ any: [{ kind: "text", text: "手", tags: [], similar: [], ratings: [] }], negate: false }],
};
const base = {
  workspaceScope: folder,
  scope: { kind: "folder" as const, id: "F" },
  conditions: tree,
  reloadKey: 0,
  selected: new Set<string>(),
  onSelectionChange: () => {},
  onOpenImage: () => {},
  viewerOpen: false,
};
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** 记录原子交付的测试 pager；令牌规则与图片墙本地 adapter 相同。 */
function recordingPager(deliveries: BrowsePageDelivery[]): BrowsePager {
  let generation = 0;
  return {
    begin: () => ++generation,
    token: () => generation,
    current: (token) => token === generation,
    invalidate: () => {
      generation += 1;
    },
    deliver: (page) => {
      if (page.token !== generation) return false;
      deliveries.push(page);
      return true;
    },
  };
}
const shown = () => [...document.querySelectorAll<HTMLElement>(".card")].map((c) => c.dataset.id);
const total = () => document.querySelector<HTMLElement>(".wall")!.dataset.total;

it("翻页带着同一范围、查找条件与安全模式，下一页接在后面，张数取最新一页的", async () => {
  const deliveries: BrowsePageDelivery[] = [];
  const wall = createRef<WallHandle>();
  render(<Wall ref={wall} {...base} safeMode browsePager={recordingPager(deliveries)} />);
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    safeMode: true,
    query: { scope: folder, conditions: tree, cursor: null, knownPlaceholders: [] },
  });
  const firstPage = Array.from({ length: PAGE }, (_, i) => card(`a${i}`));
  await act(async () => calls[0].resolve(workspacePage(firstPage, PAGE + 2, "c1")));
  await settle();
  // 第一页已取够一屏，停在这里，等滚到底部再翻。
  expect(calls).toHaveLength(1);
  expect(deliveries).toHaveLength(1);
  act(() => wall.current!.loadMore());
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    safeMode: true,
    query: { scope: folder, conditions: tree, cursor: "c1", knownPlaceholders: [] },
  });
  await act(async () => calls[1].resolve(workspacePage([card("b"), card("c")], PAGE + 2)));
  await settle();
  expect(total()).toBe(String(PAGE + 2));
  // 每一页回来都把修订与那时墙上的全部卡片作为一次原子交付交给浏览结果模块。
  expect(deliveries).toHaveLength(2);
  expect(deliveries.at(-1)!.cards.map((c) => c.id)).toEqual([...firstPage.map((c) => c.id), "b", "c"]);
  // 没有下一页了：不再翻。
  act(() => wall.current!.loadMore());
  await settle();
  expect(calls).toHaveLength(2);
});

it("重新浏览取到一半游标过期：从第一页重取，不把两次取到的卡片拼在一起", async () => {
  const view = render(<Wall {...base} safeMode={false} />);
  await settle();
  await act(async () => calls[0].resolve(workspacePage([card("a")], 1)));
  await settle();
  // 修订号前进后重新浏览：一次取够墙上已有的张数，要翻好几页。
  view.rerender(<Wall {...base} safeMode={false} reloadKey={1} />);
  await settle();
  const first = calls.length - 1;
  expect(calls[first].query.cursor).toBeNull();
  await act(async () => calls[first].resolve(workspacePage([card("x")], 600, "c1")));
  await settle();
  expect(calls[first + 1].query.cursor).toBe("c1");
  await act(async () => calls[first + 1].reject(EXPIRED));
  await settle();
  const again = calls.length - 1;
  expect(again).toBe(first + 2);
  expect(calls[again].query).toMatchObject({ cursor: null, scope: folder, conditions: tree });
  // 重取之前墙上仍是原来的卡片。
  expect(shown()).toEqual(["a"]);
  await act(async () => calls[again].resolve(workspacePage([card("y"), card("x")], 2)));
  await settle();
  expect(shown()).toEqual(["y", "x"]);
  expect(total()).toBe("2");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("重新浏览一直撞上游标过期：重取几次后报错，不无限重试", async () => {
  render(<Wall {...base} safeMode={false} />);
  await settle();
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(calls).toHaveLength(attempt + 1);
    expect(calls[attempt].query.cursor).toBeNull();
    await act(async () => calls[attempt].reject(EXPIRED));
    await settle();
  }
  expect(calls).toHaveLength(4);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(EXPIRED_TEXT);
});

it("查看器里跨页浏览时重新浏览保留正在看的图", async () => {
  const wallRef = createRef<WallHandle>();
  let loadedIds: string[] = [];
  const pageCards = (start: number) => Array.from({ length: PAGE }, (_, i) => card(`c${start + i}`));
  const record = (cards: { id: string }[]) => {
    loadedIds = cards.map((c) => c.id);
  };
  const view = render(
    <Wall ref={wallRef} {...base} safeMode={false} reloadKey={0} viewerOpen onCardsChange={record} />,
  );
  await settle();

  await act(async () => calls[0].resolve(workspacePage(pageCards(0), PAGE * 3, "c1")));
  await settle();
  // 打开查看器前墙停在首页顶部：锚点就是首页的图。
  const scroller = document.querySelector<HTMLElement>(".wall")!;
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  for (let page = 1; page < 3; page++) {
    act(() => wallRef.current!.loadMore());
    await settle();
    await act(async () =>
      calls[page].resolve(workspacePage(pageCards(page * PAGE), PAGE * 3, page < 2 ? `c${page + 1}` : null)),
    );
    await settle();
  }
  expect(loadedIds).toHaveLength(PAGE * 3);

  // 查看器已经走到第 3 页；墙因查看器盖着没有滚动，视口锚点仍停在首页。
  const reloadStarts = calls.length;
  view.rerender(
    <Wall
      ref={wallRef}
      {...base}
      safeMode={false}
      reloadKey={1}
      viewerOpen
      selected={new Set(["c1200"])}
      onCardsChange={record}
    />,
  );
  await settle();
  expect(calls.length).toBeGreaterThan(reloadStarts);
  for (let page = 0; page < 3; page++) {
    const call = calls[reloadStarts + page];
    if (!call) break;
    await act(async () =>
      call.resolve(workspacePage(pageCards(page * PAGE), PAGE * 3, page < 2 ? `r${page + 1}` : null)),
    );
    await settle();
  }
  expect(loadedIds).toHaveLength(PAGE * 3);
  expect(loadedIds).toContain("c1200");
});

it("视口锚点图被移走时重新浏览仍以邻近可见位置为下界", async () => {
  const wallRef = createRef<WallHandle>();
  let loadedIds: string[] = [];
  const pageCards = (start: number) => Array.from({ length: PAGE }, (_, i) => card(`c${start + i}`));
  const record = (cards: { id: string }[]) => {
    loadedIds = cards.map((c) => c.id);
  };
  const view = render(<Wall ref={wallRef} {...base} safeMode={false} reloadKey={0} onCardsChange={record} />);
  await settle();

  for (let page = 0; page < 5; page++) {
    await act(async () =>
      calls[page].resolve(workspacePage(pageCards(page * PAGE), PAGE * 5, page < 4 ? `c${page + 1}` : null)),
    );
    await settle();
    if (page < 4) {
      act(() => wallRef.current!.loadMore());
      await settle();
    }
  }
  expect(loadedIds).toHaveLength(PAGE * 5);

  // 1000px 宽、240px 目标列宽时一列行距是 246px；c2000 在第 500 行最左列顶端。
  const scroller = document.querySelector<HTMLElement>(".wall")!;
  scroller.scrollTop = 12 + 500 * 246;
  fireEvent.scroll(scroller);
  act(() => wallRef.current!.remove(["c2000"]));
  await settle();
  expect(loadedIds).not.toContain("c2000");

  const reloadStarts = calls.length;
  view.rerender(<Wall ref={wallRef} {...base} safeMode={false} reloadKey={1} onCardsChange={record} />);
  await settle();
  expect(calls.length).toBeGreaterThan(reloadStarts);
  for (let page = 0; page < 5; page++) {
    const call = calls[reloadStarts + page];
    if (!call) break;
    await act(async () =>
      call.resolve(workspacePage(pageCards(page * PAGE), PAGE * 5, page < 4 ? `r${page + 1}` : null)),
    );
    await settle();
  }
  // c2000 原来的位置旁边就是 c2001；重拉不能只停在 2000 张的默认上限。
  expect(loadedIds).toHaveLength(PAGE * 5 - 1);
  expect(loadedIds).toContain("c2001");
});

it("加载多页但锚点停在首屏顶部时，重新浏览只拉取首屏所需页数而不全量重拉已加载页", async () => {
  const wallRef = createRef<WallHandle>();
  const makePage = (prefix: string) => Array.from({ length: PAGE }, (_, i) => card(`${prefix}${i}`));
  const view = render(<Wall ref={wallRef} {...base} safeMode={false} reloadKey={0} />);
  await settle();

  await act(async () => calls[0].resolve(workspacePage(makePage("p0_"), PAGE * 3, "c1")));
  await settle();
  const scroller = document.querySelector<HTMLElement>(".wall")!;
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);

  act(() => wallRef.current!.loadMore());
  await settle();
  await act(async () => calls[1].resolve(workspacePage(makePage("p1_"), PAGE * 3, "c2")));
  await settle();

  act(() => wallRef.current!.loadMore());
  await settle();
  await act(async () => calls[2].resolve(workspacePage(makePage("p2_"), PAGE * 3, "c3")));
  await settle();
  expect(calls).toHaveLength(3);

  // 停在首屏时触发重新浏览：只需要取第 1 页即可满足当前视口锚点。
  view.rerender(<Wall ref={wallRef} {...base} safeMode={false} reloadKey={1} />);
  await settle();
  expect(calls).toHaveLength(4);
  await act(async () => calls[3].resolve(workspacePage(makePage("new0_"), PAGE * 3, "c1")));
  await settle();
  expect(calls).toHaveLength(4);
});
