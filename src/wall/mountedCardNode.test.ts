import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { masonry } from "./layout";
import { mountedCardNode, type RenderedCards } from "./mountedCardNode";
import type { CardHandlers } from "./WallCard";
import type { BrowserCard } from "./wallShared";

beforeEach(() => {
  mockConvertFileSrc("windows");
});

function card(id: string): BrowserCard {
  return {
    id,
    width: 200,
    height: 300,
    adult: false,
    libraryId: "L1",
    imageId: id,
    sources: [{ libraryId: "L1", libraryName: "主库", imageId: id, unavailable: null, matches: true, deleted: false }],
  };
}

const noopHandlers = {
  current: {
    click: vi.fn(),
    open: vi.fn(),
    cardKey: vi.fn(),
    dragStart: vi.fn(),
    openTray: vi.fn(),
    check: vi.fn(),
  } satisfies CardHandlers,
};

describe("mountedCardNode 卡片复用缓存", () => {
  const layoutOpts = { width: 800, target: 240, gap: 8, pad: 12, capRatio: 2.6 };

  it("翻页追加后重算 layout 产生新 Box 与等价卡片对象时复用原有 React 节点", () => {
    const first = [card("a"), card("b")];
    const layout1 = masonry(
      first.map((c) => ({ w: c.width, h: c.height })),
      layoutOpts,
    );
    const rendered: RenderedCards = new Map();
    const next1: RenderedCards = new Map();
    const lastOpened = { current: null };

    const node1 = mountedCardNode({
      i: 0,
      shown: first,
      layout: layout1,
      safeMode: true,
      revealed: new Set(),
      selected: new Set(),
      arriving: new Set(),
      tray: null,
      renderedCards: { current: rendered },
      nextRendered: next1,
      tier: 256,
      language: "zh-CN",
      thumbnailPx: 240,
      workspaceScope: { kind: "all" },
      cardHandlers: noopHandlers,
      lastOpened,
      uiScale: 1,
    });

    // 追加第三张卡片并深拷贝前一张卡片，产生全新 layout.boxes[0] 引用。
    const appended = [structuredClone(first[0]), first[1], card("c")];
    const layout2 = masonry(
      appended.map((c) => ({ w: c.width, h: c.height })),
      layoutOpts,
    );
    expect(layout2.boxes[0]).not.toBe(layout1.boxes[0]);
    expect(layout2.boxes[0]).toEqual(layout1.boxes[0]);

    const next2: RenderedCards = new Map();
    const node2 = mountedCardNode({
      i: 0,
      shown: appended,
      layout: layout2,
      safeMode: true,
      revealed: new Set(),
      selected: new Set(),
      arriving: new Set(),
      tray: null,
      renderedCards: { current: next1 },
      nextRendered: next2,
      tier: 256,
      language: "zh-CN",
      thumbnailPx: 240,
      workspaceScope: { kind: "all" },
      cardHandlers: noopHandlers,
      lastOpened,
      uiScale: 1,
    });

    expect(node2).toBe(node1);
  });

  it("坐标、选中态或卡片字段变化时重新生成节点", () => {
    const items = [card("a")];
    const layout1 = masonry(
      items.map((c) => ({ w: c.width, h: c.height })),
      layoutOpts,
    );
    const next1: RenderedCards = new Map();
    const lastOpened = { current: null };

    const base = {
      i: 0,
      shown: items,
      layout: layout1,
      safeMode: true,
      revealed: new Set<string>(),
      selected: new Set<string>(),
      arriving: new Set<string>(),
      tray: null,
      tier: 256,
      language: "zh-CN",
      thumbnailPx: 240,
      workspaceScope: { kind: "all" as const },
      cardHandlers: noopHandlers,
      lastOpened,
      uiScale: 1,
    };

    const node1 = mountedCardNode({ ...base, renderedCards: { current: new Map() }, nextRendered: next1 });

    // 布局坐标变化
    const shiftedLayout = {
      ...layout1,
      boxes: [{ ...layout1.boxes[0], y: layout1.boxes[0].y + 10 }],
    };
    const nodeMoved = mountedCardNode({
      ...base,
      layout: shiftedLayout,
      renderedCards: { current: next1 },
      nextRendered: new Map(),
    });
    expect(nodeMoved).not.toBe(node1);

    // 选中态变化
    const nodeSelected = mountedCardNode({
      ...base,
      selected: new Set(["a"]),
      renderedCards: { current: next1 },
      nextRendered: new Map(),
    });
    expect(nodeSelected).not.toBe(node1);

    // 占位图变化
    const nodePlaceholder = mountedCardNode({
      ...base,
      shown: [{ ...items[0], placeholder: "data:image/png;base64,abc" }],
      renderedCards: { current: next1 },
      nextRendered: new Map(),
    });
    expect(nodePlaceholder).not.toBe(node1);
  });
});
