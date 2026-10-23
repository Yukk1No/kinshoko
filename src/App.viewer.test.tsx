import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import type { BrowsePage } from "./bindings/BrowsePage";
import { App } from "./App";
import { doubleClick, library, gone, clean, backend, sent, push, libraryAction, openLibrary, expandLibrary } from "./App.fixtures";

describe("主窗口", () => {
  it("双击打开原图；Esc 返回原位置并把焦点交还参考图", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = document.querySelector<HTMLElement>(".wall")!;
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    wall.scrollTop = 120;
    fireEvent.scroll(wall);
    doubleClick(card);
    const viewer = await screen.findByRole("region", { name: "原图查看器" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/L1/a/full");
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wall.scrollTop).toBe(120);
    expect(document.activeElement).toBe(card);

    fireEvent.keyDown(card, { key: "Enter" });
    expect(await screen.findByRole("region", { name: "原图查看器" })).toBeTruthy();
  });

  it("单击参考图：选中它并展开详情面板，不打开查看器；单击空白处收起（#146）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const inspector = () => document.querySelector<HTMLElement>("aside.inspector");
    expect(inspector()).toBeNull();
    fireEvent.click(document.querySelector<HTMLElement>('[data-id="a"]')!);
    expect(inspector()!.getAttribute("data-collapsed")).toBe("false");
    expect(inspector()!.dataset.selection).toBe("a");
    // 详情面板里没有缩略图（#179）。
    expect(within(inspector()!).queryByRole("img")).toBeNull();
    expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull();
    fireEvent.click(document.querySelector<HTMLElement>(".wall-canvas")!);
    expect(inspector()).toBeNull();
  });

  it("查看器的下一张 / 上一张按图片墙顺序换图", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const ids = [...document.querySelectorAll<HTMLElement>(".wall [data-id]")].map((card) => card.dataset.id!);
    doubleClick(document.querySelector<HTMLElement>(`[data-id="${ids[0]}"]`)!);
    const viewer = await screen.findByRole("region", { name: "原图查看器" });
    expect(within(viewer).getByText(`1 / ${ids.length}`)).toBeTruthy();
    fireEvent.click(within(viewer).getByRole("button", { name: "下一张" }));
    await waitFor(() => expect(viewer.querySelector("img")?.getAttribute("src")).toBe(`http://thumb.localhost/L1/${ids[1]}/full`));
    expect(within(viewer).getByText(`2 / ${ids.length}`)).toBeTruthy();
    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    await waitFor(() => expect(viewer.querySelector("img")?.getAttribute("src")).toBe(`http://thumb.localhost/L1/${ids[0]}/full`));
  });

  it("查看器只盖住图片墙（#179）：左栏、顶栏可用，详情侧栏在旁边跟着 ←/→ 换图，I 键显示或隐藏它", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const ids = [...document.querySelectorAll<HTMLElement>(".wall [data-id]")].map((card) => card.dataset.id!);
    const inspector = () => document.querySelector<HTMLElement>("aside.inspector");
    doubleClick(document.querySelector<HTMLElement>(`[data-id="${ids[0]}"]`)!);
    const viewer = await screen.findByRole("region", { name: "原图查看器" });
    // 查看器在图片墙所在的区域里，图片大小调整条藏起来；左栏、顶栏与详情侧栏都不是 inert。
    expect(viewer.closest(".wall-host")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "图片大小" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "图片墙" }).hasAttribute("inert")).toBe(true);
    for (const area of [document.querySelector(".rail-slot")!, screen.getByRole("complementary", { name: "文件夹" }), document.querySelector(".topbar")!, inspector()!]) {
      expect(area.closest("[inert]")).toBeNull();
    }
    expect(inspector()!.dataset.selection).toBe(ids[0]);
    expect(inspector()!.dataset.collapsed).toBe("false");
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    await waitFor(() => expect(inspector()!.dataset.selection).toBe(ids[1]));
    // I 隐藏详情侧栏；换图时保持隐藏。
    fireEvent.keyDown(viewer, { key: "i" });
    expect(inspector()!.dataset.collapsed).toBe("true");
    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    await waitFor(() => expect(viewer.querySelector("img")?.getAttribute("src")).toBe(`http://thumb.localhost/L1/${ids[0]}/full`));
    expect(inspector()!.dataset.collapsed).toBe("true");
    fireEvent.click(within(viewer).getByRole("button", { name: /^显示详情/ }));
    expect(inspector()!.dataset.collapsed).toBe("false");
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    await waitFor(() => expect(inspector()!.dataset.selection).toBe(ids[1]));
    // Esc：选择是最后看的那张，侧栏开合不变，那张卡片获得焦点。
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull();
    const last = document.querySelector<HTMLElement>(`[data-id="${ids[1]}"]`)!;
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll('.wall [aria-selected="true"]')).toHaveLength(1);
    expect(inspector()!.dataset.collapsed).toBe("false");
    expect(document.activeElement).toBe(last);
    expect(screen.getByRole("group", { name: "图片大小" })).toBeTruthy();
  });

  it("查看中在左栏切换浏览范围：离开查看器，进入新的范围（#179）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("region", { name: "原图查看器" });
    await expandLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "人物（1 张）" }));
    expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull();
    expect(screen.getByRole("button", { name: "人物（1 张）" }).getAttribute("aria-current")).toBe("page");
  });

  it("单击已选中的唯一那张打开查看器；多选时单击其中一张只收缩选择（#179）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    fireEvent.click(card("a"));
    fireEvent.click(card("b"), { ctrlKey: true });
    fireEvent.click(card("a"));
    expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull();
    expect(document.querySelectorAll('.wall [aria-selected="true"]')).toHaveLength(1);
    fireEvent.click(card("a"));
    expect(await screen.findByRole("region", { name: "原图查看器" })).toBeTruthy();
  });

  it("查看器的下一张越过已读到的卡片时，先读下一页再换图", async () => {
    let second!: (value: BrowsePage) => void;
    const more = new Promise<BrowsePage>((resolve) => { second = resolve; });
    const cards = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, width: 100, height: 100, thumbnail: `L1/p${i}/256`, adult: false }));
    const first: BrowsePage = { cards, nextCursor: "c2", total: 501 };
    const rest: BrowsePage = { cards: [{ id: "last", width: 100, height: 100, thumbnail: "L1/last/256", adult: false }], nextCursor: null, total: 501 };
    // 前面的用例保存过滚动锚点；从顶部开始，第一页就够。
    localStorage.clear();
    backend(library, clean, (cmd, args) => {
      if (cmd !== "plugin:library|browse") return undefined;
      return (args as { query: { cursor?: string | null } }).query.cursor ? more : first;
    });
    render(<App />);
    await screen.findAllByRole("img");
    // 滚到底：最后一张已读到的卡片挂上，下一页还在路上。
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    wall.scrollTop = parseFloat(wall.querySelector<HTMLElement>(".wall-canvas")!.style.height) - 800;
    fireEvent.scroll(wall);
    const lastLoaded = await waitFor(() => { const node = document.querySelector<HTMLElement>('[data-id="p499"]'); if (!node) throw new Error("not mounted"); return node; });
    doubleClick(lastLoaded);
    const viewer = await screen.findByRole("region", { name: "原图查看器" });
    expect(within(viewer).getByText("500 / 501")).toBeTruthy();
    const next = within(viewer).getByRole("button", { name: "下一张" });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(next);
    await act(async () => { second(rest); await more; });
    await waitFor(() => expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/L1/last/full"));
    expect(within(viewer).getByText("501 / 501")).toBeTruthy();
  });

  it("开启安全模式时关闭查看器，回到图片墙", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await screen.findAllByRole("img");
    doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("region", { name: "原图查看器" });
    await push({ kind: "safeModeChanged", libraryId: "L1", on: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("正在查看的图查不到（UnknownImage）时关闭查看器", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("region", { name: "原图查看器" });
    gone.add("a");
    await push({ kind: "listStale", libraryId: "L1" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("整理在等某个图库的导入收尾时给轻提示，查看与选择照旧（#112）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("region", { name: "原图查看器" });

    await act(() => emit("organize-waiting", { libraryId: "L2", finishing: ["工作参考"] }));

    expect(await screen.findByText("导入收尾后再整理")).toBeTruthy();
    expect(screen.getByText("「工作参考」的导入完成后自动执行")).toBeTruthy();
    expect(screen.getByRole("region", { name: "原图查看器" })).toBeTruthy();
  });

  it("后端按需切到的另一个图库：它的列表变化刷新图片墙，它的安全模式与导入事件不串台（#112）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    doubleClick(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await screen.findByRole("region", { name: "原图查看器" });

    await push({ kind: "safeModeChanged", libraryId: "L2", on: true });
    await push({ kind: "taskProgress", libraryId: "L2", taskId: "T9", progress: { done: 1, total: 9 } });
    expect(screen.getByRole("region", { name: "原图查看器" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();

    gone.add("a");
    await push({ kind: "listStale", libraryId: "L2" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("登记已有资料库后打开它，取消登记后可以继续建库或重新登记", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    await openLibrary();
    expect(sent("plugin:library|register_library")).toEqual([{ root: "E:\\私人收藏" }]);
    await libraryAction(/管理图库/);
    fireEvent.click(await screen.findByRole("button", { name: "移除 私人收藏" }));
    await waitFor(() => expect(sent("plugin:library|unregister_library")).toEqual([{ libraryId: "L2" }]));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(await screen.findByRole("button", { name: "新建图库" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开图库" })).toBeTruthy();
  });

});
