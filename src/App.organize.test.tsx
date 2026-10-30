import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { library, page, clean, backend, sent, selectionPanel, selectionBar, expandLibrary } from "./App.fixtures";

describe("整理", () => {
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

  it("侧栏列出全部、文件夹树与回收站及其计数，点文件夹按文件夹浏览", async () => {
    backend(library);
    render(<App />);
    expect(await screen.findByRole("button", { name: "工作参考（2 张）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "全部图片（2 张）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "回收站（全部图库，1 张）" })).toBeTruthy();
    await expandLibrary();
    const nav = await screen.findByRole("navigation", { name: "工作参考的目录" });
    await waitFor(() => expect(nav.textContent).toContain("发型"));
    expect(screen.getByRole("button", { name: "人物（1 张）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "发型（0 张）" }));
    await waitFor(() =>
      expect(sent("plugin:library|browse").at(-1)).toMatchObject({
        query: { scope: { kind: "folderTree", id: "F2" } },
      }),
    );
    // 选中了这个图库的文件夹：回收站是它的。
    fireEvent.click(screen.getByRole("button", { name: "回收站（工作参考，1 张）" }));
    await waitFor(() =>
      expect(sent("plugin:library|browse").at(-1)).toMatchObject({
        query: { scope: { kind: "trash" } },
      }),
    );
  });

  it("新建文件夹放在当前打开的文件夹里，双击改名", async () => {
    backend(library);
    render(<App />);
    await expandLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "人物（1 张）" }));
    fireEvent.click(screen.getByRole("button", { name: "工作参考 的操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "新建文件夹" }));
    const input = screen.getByLabelText("新文件夹名称");
    fireEvent.change(input, { target: { value: "姿势" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|create_folder")).toEqual([{ libraryId: "L1", name: "姿势", parent: "F1" }]),
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "发型（0 张）" }));
    const rename = screen.getByLabelText("文件夹名称");
    fireEvent.change(rename, { target: { value: "发型与刘海" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|rename_folder")).toEqual([{ libraryId: "L1", folderId: "F2", name: "发型与刘海" }]),
    );
  });

  it("选中多张图后批量放入文件夹、删除；回收站里只选一张时走右键菜单还原（#180）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("a"), { key: " " });
    expect(selectionBar()).toBeNull();
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(within(selectionBar()!).getByText("已选 2 张")).toBeTruthy();

    const put = screen.getByRole("button", { name: "移到文件夹" });
    await waitFor(() => expect(put).toHaveProperty("disabled", false));
    fireEvent.click(put);
    fireEvent.click(await screen.findByRole("menuitem", { name: /发型/ }));
    await waitFor(() =>
      expect(sent("plugin:library|edit")).toEqual([
        { libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "addToFolder", folderId: "F2" }] },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "移到回收站，Del" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "delete" }] }),
    );
    await waitFor(() => expect(selectionPanel()).toBeNull());
    await waitFor(() => expect(selectionBar()).toBeNull());

    // 只有一个图库：“全部图片”下的回收站直接打开它。
    fireEvent.click(screen.getByRole("button", { name: "回收站（全部图库，1 张）" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    expect(selectionBar()).toBeNull();
    fireEvent.contextMenu(card("a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "还原" }));
    await waitFor(() =>
      expect(sent("plugin:library|workspace_edit_sources").at(-1)).toMatchObject({ targets: [{ imageId: "a" }], edits: [{ kind: "restore" }] }),
    );
  });

  it("多选时右下角那一组收成圆形按钮让位，取消多选后恢复（#180）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const island = () => screen.getByRole("group", { name: "图片大小" });
    fireEvent.keyDown(card("a"), { key: " " });
    expect(island().classList.contains("is-collapsed")).toBe(false);
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(island().classList.contains("is-collapsed")).toBe(true);
    expect(screen.queryByRole("slider", { name: "图片大小" })).toBeNull();
    expect(within(island()).getByRole("button", { name: "图片大小" })).toBeTruthy();

    fireEvent.click(within(selectionBar()!).getByRole("button", { name: "取消选择" }));
    await waitFor(() => expect(selectionBar()).toBeNull());
    expect(island().classList.contains("is-collapsed")).toBe(false);
    expect(screen.getByRole("slider", { name: "图片大小" })).toBeTruthy();
  });

  it("多选时打开查看器，悬浮栏隐藏（#180）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(selectionBar()).toBeTruthy();
    fireEvent.keyDown(card("b"), { key: "Enter" });
    await screen.findByRole("region", { name: "原图查看器" });
    await waitFor(() => expect(selectionBar()).toBeNull());
  });

  it("在窗口打开时以外的图库里多选，详情面板照样批量整理，请求带上那个图库（ADR-0008，#113）", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(await screen.findByRole("button", { name: "私人收藏（2 张）" }));
    await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(within(await waitFor(() => selectionBar()!)).getByText("已选 2 张")).toBeTruthy();

    const put = screen.getByRole("button", { name: "移到文件夹" });
    await waitFor(() => expect(put).toHaveProperty("disabled", false));
    fireEvent.click(put);
    fireEvent.click(await screen.findByRole("menuitem", { name: /发型/ }));
    await waitFor(() =>
      expect(sent("plugin:library|edit")).toEqual([
        { libraryId: "L2", ids: ["a", "b"], edits: [{ kind: "addToFolder", folderId: "F2" }] },
      ]),
    );
  });

  it("回收站里永久删除：先列出受影响的参考组，过期时重新预览后再确认", async () => {
    let previews = 0;
    let stale = true;
    backend(library, clean, (cmd, args) => {
      if (cmd === "plugin:library|workspace_preview_source_delete") {
        previews += 1;
        const ids = [(args as { target: { imageId: string } }).target.imageId];
        return {
          imageIds: ids,
          groups: previews === 1 ? [] : [{ groupId: "G1", name: "手的参考", imageIds: ids }],
          token: `T${previews}`,
        };
      }
      if (cmd === "plugin:library|workspace_permanent_source_delete") {
        if (stale) {
          stale = false;
          return Promise.reject({ code: "deletePreviewStale" });
        }
        return null;
      }
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    // 目录与图片独立载入，先确认该库的目标控件实际就绪。
    // 回收站固定在侧栏底部（#98），跟随所选图库（#113）。
    const trash = await screen.findByRole("button", { name: "回收站（全部图库，1 张）" });
    expect(trash).toHaveProperty("disabled", false);
    fireEvent.click(trash);
    await waitFor(() => expect(card("a")).toBeTruthy());
    // 只选一张时没有悬浮栏（#180）：从右键菜单彻底删除。
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.contextMenu(card("a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "彻底删除…" }));

    // 没有受影响的参考组：直接确认。
    expect(await screen.findByText(/永久删除这 1 张图/)).toBeTruthy();
    expect(screen.queryByLabelText("受影响的参考组")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));

    // 预览之后有参考组用上了这张图：被拒绝，重新列出后再确认。
    const list = await screen.findByLabelText("受影响的参考组");
    expect(within(list).getByText("手的参考（1 张）")).toBeTruthy();
    expect(screen.getByText(/刚有变化/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
    await waitFor(() =>
      expect(sent("plugin:library|workspace_permanent_source_delete")).toMatchObject([
        { target: { libraryId: "L1", imageId: "a" }, token: "T1" },
        { target: { libraryId: "L1", imageId: "a" }, token: "T2" },
      ]),
    );
    await waitFor(() => expect(selectionPanel()).toBeNull());
  });

  it("收起详情面板后，永久删除的确认仍是可见、可操作的提醒对话框", async () => {
    backend(library, clean, (cmd, args) => {
      if (cmd === "plugin:library|workspace_preview_source_delete") return { imageIds: [(args as { target: { imageId: string } }).target.imageId], groups: [], token: "T1" };
      if (cmd === "plugin:library|workspace_permanent_source_delete") return null;
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(await screen.findByRole("button", { name: "回收站（全部图库，1 张）" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(await screen.findByRole("button", { name: "收起详情" }));
    await waitFor(() => expect(screen.getByLabelText("详情", { selector: "aside" }).getAttribute("data-collapsed")).toBe("true"));
    fireEvent.contextMenu(card("a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "彻底删除…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "永久删除" });
    expect(dialog.closest("[inert], [aria-hidden='true']")).toBeNull();
    expect(dialog.closest("aside")).toBeNull();
    expect(within(dialog).getByText(/永久删除这 1 张图/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "确认永久删除" });
    expect(confirm.className).toContain("k-btn");
    expect(confirm.className).toContain("is-danger");
    fireEvent.click(confirm);
    await waitFor(() => expect(sent("plugin:library|workspace_permanent_source_delete")).toMatchObject([{ target: { libraryId: "L1", imageId: "a" }, token: "T1" }]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("只选一张时写备注，并能退回来源的备注", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("a"), { key: " " });
    expect(within(await screen.findByRole("region", { name: "所在文件夹" })).getByText("人物")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "看左手" } });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({
        libraryId: "L1",
        ids: ["a"],
        edits: [{ kind: "setNote", text: "看左手" }],
      }),
    );
    const revert = screen.getByRole("button", { name: "退回来源备注" });
    await waitFor(() => expect((revert as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(revert);
    await waitFor(() =>
      expect(sent("plugin:library|edit").at(-1)).toEqual({ libraryId: "L1", ids: ["a"], edits: [{ kind: "revertNote" }] }),
    );
  });
});


describe("聚合来源操作的工作区通知", () => {
  it("已加载的同一修订通知不会取消正在整理的选择", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
    await act(() => emit("workspace-changed", { revision: "fixture", libraries: [{ library, unavailable: null }] }));
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
  });

  it("新修订（例如在详情面板改了标签）保留仍然存在的选中图，详情面板保持打开", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
    const browses = sent("plugin:library|browse").length;
    await act(() => emit("workspace-changed", { revision: "after-tag-edit", libraries: [{ library, unavailable: null }] }));
    // 图片墙按新修订重读之后，选择仍在，详情面板仍打开。
    await waitFor(() => expect(sent("plugin:library|browse").length).toBeGreaterThan(browses));
    await waitFor(() => expect(document.querySelector('[data-id="a"]')?.getAttribute("aria-selected")).toBe("true"));
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
    expect(screen.getByLabelText("详情", { selector: "aside" }).getAttribute("data-collapsed")).toBe("false");
  });

  it("新修订里已不存在的选中图（删除或移出当前范围）从选择中去掉", async () => {
    let gone = false;
    backend(library, clean, (cmd) => cmd === "plugin:library|browse" && gone ? { ...page, cards: page.cards.filter((c) => c.id !== "a"), total: 1 } : undefined);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="b"]')!, { key: " ", ctrlKey: true });
    expect(screen.getByText("已选 2 张")).toBeTruthy();
    gone = true;
    await act(() => emit("workspace-changed", { revision: "after-delete", libraries: [{ library, unavailable: null }] }));
    await waitFor(() => expect(document.querySelector('[data-id="a"]')).toBeNull());
    await waitFor(() => expect(selectionBar()).toBeNull()); expect(selectionPanel()).toBeTruthy();
    expect(document.querySelector('[data-id="b"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("唯一的选中图在新修订里不存在时清空选择，详情面板随之收起", async () => {
    let gone = false;
    backend(library, clean, (cmd) => cmd === "plugin:library|browse" && gone ? { ...page, cards: page.cards.filter((c) => c.id !== "a"), total: 1 } : undefined);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-id="a"]')!, { key: " " });
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
    gone = true;
    await act(() => emit("workspace-changed", { revision: "after-delete", libraries: [{ library, unavailable: null }] }));
    await waitFor(() => expect(document.querySelector('[data-id="a"]')).toBeNull());
    await waitFor(() => expect(selectionPanel()).toBeNull());
    expect(selectionBar()).toBeNull();
  });
});
