import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Wall } from "./Wall";

// #110：缩略图到达前先显示随浏览页带回的占位图，缩略图到达后淡入并盖住它。
const PLACEHOLDER = "data:image/webp;base64,UklGRg==";

let cards: { id: string; width: number; height: number; thumbnail: string; placeholder?: string; adult: boolean }[];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  cards = [];
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return { cards, total: cards.length, nextCursor: null };
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const wall = (safeMode = false) => render(<Wall libraryId="L1" scope={{ kind: "all" }} reloadKey={0} safeMode={safeMode}
  selected={new Set()} onSelectionChange={() => {}} onOpenImage={() => {}} viewerOpen={false} />);
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
const placeholderOf = (id: string) => card(id).querySelector<HTMLElement>(".card-placeholder");

it("缩略图到达前显示同色调的占位图，到达后缩略图淡入", async () => {
  cards = [{ id: "a", width: 100, height: 50, thumbnail: "L1/a/256", placeholder: PLACEHOLDER, adult: false }];
  wall();
  const [thumbnail] = await screen.findAllByRole("img");
  expect(placeholderOf("a")?.style.backgroundImage).toContain(PLACEHOLDER);
  expect(thumbnail.dataset.loaded).toBeUndefined();

  fireEvent.load(thumbnail);
  expect(thumbnail.dataset.loaded).toBe("fade");
});

it("还没有占位图的卡片只留中性底色", async () => {
  cards = [{ id: "a", width: 100, height: 50, thumbnail: "L1/a/256", adult: false }];
  wall();
  await screen.findAllByRole("img");
  expect(placeholderOf("a")).toBeNull();
});

it("遮蔽中的成人内容卡片不显示占位色彩", async () => {
  cards = [
    { id: "a", width: 100, height: 50, thumbnail: "L1/a/256", placeholder: PLACEHOLDER, adult: true },
    { id: "b", width: 100, height: 50, thumbnail: "L1/b/256", placeholder: PLACEHOLDER, adult: false },
  ];
  wall(true);
  await screen.findAllByRole("img");
  expect(card("a").dataset.veiled).toBe("true");
  expect(placeholderOf("a")).toBeNull();
  expect(placeholderOf("b")).not.toBeNull();
});

it("卡片卸载时缩略图还没到就撤掉地址，浏览器放弃这次请求；已到的不动（#123）", async () => {
  cards = [
    { id: "a", width: 100, height: 50, thumbnail: "L1/a/256", adult: false },
    { id: "b", width: 100, height: 50, thumbnail: "L1/b/256", adult: false },
  ];
  const view = wall();
  const [pending, arrived] = await screen.findAllByRole("img") as HTMLImageElement[];
  Object.defineProperty(pending, "complete", { configurable: true, value: false });
  Object.defineProperty(arrived, "complete", { configurable: true, value: true });
  expect(pending.getAttribute("src")).toContain("L1/a/256");
  view.unmount();
  expect(pending.hasAttribute("src")).toBe(false);
  expect(arrived.getAttribute("src")).toContain("L1/b/256");
});
