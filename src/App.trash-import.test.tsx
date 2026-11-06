import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { backend, clean, library, push, sent } from "./App.fixtures";

/** 回收站里不能发起新的导入，接着之前导入的操作照常（ADR-0016）。 */
describe("回收站范围下的导入", () => {
  const paths = ["D:\\参考\\a.png"];
  const position = { x: 10, y: 10 };
  const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const menuItem = (name: RegExp) => screen.getByRole("menuitem", { name });
  const disabled = (item: HTMLElement) => item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true";

  async function inTrash(override?: Parameters<typeof backend>[2]) {
    backend(library, clean, override);
    render(<App />);
    await screen.findAllByRole("img");
    // 拖放监听异步注册：等它就绪。
    await tick();
    fireEvent.click(await screen.findByRole("button", { name: "回收站（全部图库，1 张）" }));
    await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ query: { scope: { kind: "trash" } } }));
    await tick();
  }

  it("导入按钮的图片、文件夹、Eagle 都禁用", async () => {
    await inTrash();
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    for (const name of [/^图片/, /^文件夹/, /从 Eagle 导入/]) expect(disabled(await screen.findByRole("menuitem", { name }))).toBe(true);
  });

  it("离开回收站后导入按钮恢复", async () => {
    await inTrash();
    fireEvent.click(screen.getByRole("button", { name: "全部图片（2 张）" }));
    await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ query: { scope: { kind: "all" } } }));
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    expect(disabled(await screen.findByRole("menuitem", { name: /^图片/ }))).toBe(false);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /^图片/ }), { key: "Escape" });
    await act(() => emit("tauri://drag-enter", { paths, position }));
    expect(await screen.findByRole("img", { name: /松开即可导入到/ })).toBeTruthy();
    expect(document.querySelector(".k-drop-hint")!.textContent).toBe("");
  });

  it("离开回收站后 Ctrl V 恢复", async () => {
    await inTrash((cmd) => {
      if (cmd === "plugin:desktop|stage_clipboard_import") throw "剪贴板里没有图片";
      return undefined;
    });
    fireEvent.click(screen.getByRole("button", { name: "全部图片（2 张）" }));
    await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ query: { scope: { kind: "all" } } }));
    fireEvent.keyDown(document, { key: "v", ctrlKey: true });
    await waitFor(() => expect(sent("plugin:desktop|stage_clipboard_import")).toHaveLength(1));
  });

  it("图片墙右键菜单的导入项和从剪贴板导入都禁用", async () => {
    await inTrash();
    fireEvent.contextMenu(document.querySelector<HTMLElement>(".wall")!);
    expect(disabled(await screen.findByRole("menuitem", { name: /^导入/ }))).toBe(true);
    expect(disabled(menuItem(/从剪贴板导入/))).toBe(true);
  });

  it("Ctrl O 和 Ctrl V 没有反应", async () => {
    await inTrash();
    fireEvent.keyDown(document, { key: "o", ctrlKey: true });
    fireEvent.keyDown(document, { key: "v", ctrlKey: true });
    await tick();
    expect(sent("plugin:library|pick_files")).toEqual([]);
    expect(sent("plugin:desktop|stage_clipboard_import")).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "导入图片" })).toBeNull();
  });

  it("拖入时不显示松开即可导入；松开后不导入，只发一条不是错误的通知", async () => {
    await inTrash();
    await act(() => emit("tauri://drag-enter", { paths, position }));
    expect(screen.queryByRole("img", { name: /松开即可导入/ })).toBeNull();

    await act(() => emit("tauri://drag-drop", { paths, position }));

    const notice = await screen.findByText("回收站内无法导入");
    expect(notice.getAttribute("data-type")).not.toBe("error");
    expect(screen.queryByRole("alert")).toBeNull();
    await tick();
    expect(sent("plugin:library|import_contains_eagle")).toEqual([]);
    expect(sent("plugin:library|start_import")).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "导入图片" })).toBeNull();
  });

  it("导入任务和结果卡的重试照常可用", async () => {
    await inTrash();
    const report = {
      cancelled: false, fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0, eagleRelocations: [],
      items: [{ path: "D:\\参考\\坏.png", outcome: { kind: "readFailed", reason: { code: "system", detail: "被占用" } } }],
    };
    await push({ kind: "taskFinished", libraryId: "L1", taskId: "T1", report } as never);

    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /导入任务/ }));
    const card = await screen.findByRole("region", { name: "导入结果" });
    fireEvent.click(within(card).getByRole("button", { name: "重试失败的 1 项" }));

    expect(await screen.findByRole("dialog", { name: "导入图片" })).toBeTruthy();
  });
});
