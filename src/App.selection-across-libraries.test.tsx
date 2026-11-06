import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { backend, clean, library, page, selectionBar, sent } from "./App.fixtures";

const source = (libraryId: string, imageId: string) => ({ libraryId, libraryName: libraryId, imageId, matches: true, unavailable: null, deleted: false });
/** 每张卡片的来源；第一份是卡片显示的那份。 */
const sources: Record<string, ReturnType<typeof source>[]> = {
  a: [source("L1", "a")],
  b: [source("L1", "b")],
  x: [source("L2", "x")],
  m: [source("L1", "m"), source("L2", "m2")],
};

function start() {
  const first = page.cards[0];
  backend(library, clean, (cmd) => cmd === "plugin:library|browse"
    ? { ...page, total: 4, nextCursor: null, cards: Object.keys(sources).map((id) => ({ ...first, id, thumbnail: `L1/${id}/256` })) }
    : undefined);
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = async (...args) => {
    const value = await invoke(...args);
    if (args[0] !== "plugin:library|workspace_browse") return value;
    const result = value as { cards: { id: string }[] };
    return { ...result, cards: result.cards.map((card) => ({ ...card, libraryId: sources[card.id][0].libraryId, imageId: sources[card.id][0].imageId, sources: sources[card.id] })) };
  };
  render(<App />);
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
const pick = (first: string, ...rest: string[]) => {
  fireEvent.keyDown(card(first), { key: " " });
  for (const id of rest) fireEvent.click(card(id), { ctrlKey: true });
};
const bar = () => waitFor(() => { const toolbar = selectionBar(); if (!toolbar) throw new Error("多选悬浮栏不在"); return toolbar; });
/** 退场动画结束后读：离开中的悬浮栏还留在 DOM 里，不能算还在。 */
const settled = () => new Promise((done) => setTimeout(done, 1000));

describe("多选悬浮栏：选择跨图库", () => {
  it("加选另一个图库的图，悬浮栏留下，读数跟上，文件夹操作禁用", async () => {
    start();
    await screen.findAllByRole("img");
    pick("a", "b");
    await waitFor(async () => expect(within(await bar()).getByRole("button", { name: "移到文件夹" })).toHaveProperty("disabled", false));

    fireEvent.click(card("x"), { ctrlKey: true });
    await settled();
    const toolbar = await bar();
    expect(within(toolbar).getByText("已选 3 张")).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "移到文件夹" })).toHaveProperty("disabled", true);

    fireEvent.click(card("x"), { ctrlKey: true });
    await waitFor(() => expect(within(selectionBar()!).getByRole("button", { name: "移到文件夹" })).toHaveProperty("disabled", false));
  });

  it("移到回收站按图库写入，只动卡片显示的那份来源，然后取消选择", async () => {
    start();
    await screen.findAllByRole("img");
    pick("a", "x", "m");
    await settled();
    fireEvent.click(within(await bar()).getByRole("button", { name: "移到回收站，Del" }));
    await waitFor(() => expect(sent("plugin:library|workspace_edit_sources").at(-1)).toMatchObject({
      targets: [
        { libraryId: "L1", imageId: "a", contentId: "a" },
        { libraryId: "L2", imageId: "x", contentId: "x" },
        { libraryId: "L1", imageId: "m", contentId: "m" },
      ],
      edits: [{ kind: "delete" }],
    }));
    expect(sent("plugin:library|edit")).toEqual([]);
    await waitFor(() => expect(selectionBar()).toBeNull());
  });

  it("显示的来源都在同一个图库、但含多份来源的图：文件夹跟右键菜单一样可用，写入那份来源", async () => {
    start();
    await screen.findAllByRole("img");
    pick("a", "m");
    await settled();
    const put = within(await bar()).getByRole("button", { name: "移到文件夹" });
    await waitFor(() => expect(put).toHaveProperty("disabled", false));
    fireEvent.click(put);
    fireEvent.click(await screen.findByRole("menuitem", { name: /发型/ }));
    await waitFor(() => expect(sent("plugin:library|workspace_edit_sources").at(-1)).toMatchObject({
      targets: [{ libraryId: "L1", imageId: "a" }, { libraryId: "L1", imageId: "m" }],
      edits: [{ kind: "addToFolder", folderId: "F2" }],
    }));
    expect(selectionBar()).toBeTruthy();
  });

  it("取消选择在跨图库时照常可用", async () => {
    start();
    await screen.findAllByRole("img");
    pick("a", "x");
    await settled();
    fireEvent.click(within(await bar()).getByRole("button", { name: "取消选择" }));
    await waitFor(() => expect(selectionBar()).toBeNull());
    expect(document.querySelectorAll('.card[aria-selected="true"]').length).toBe(0);
  });
});
