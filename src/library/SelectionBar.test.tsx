import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { BrowseScope } from "../bindings/BrowseScope";
import { SelectionBar } from "./SelectionBar";

afterEach(() => {
  cleanup();
  clearMocks();
});

const FOLDERS = [{ id: "F1", name: "人物", count: 1, children: [{ id: "F2", name: "发型", count: 0, children: [] }] }];

function backend(folders: unknown[] = FOLDERS) {
  const edits: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_sidebar") return { all: 2, trash: 0, folders };
    if (cmd === "plugin:library|edit") { edits.push(args); return []; }
    return undefined;
  });
  return edits;
}

function renderBar(scope: BrowseScope = { kind: "all" }, onClear = vi.fn()) {
  render(<SelectionBar libraryId="L1" scope={scope} ids={["a", "b"]} onClear={onClear} reloadKey={0} onError={() => {}} left={0} onWidth={() => {}} />);
  return { onClear, bar: screen.getByRole("toolbar", { name: "已选参考图操作" }) };
}

describe("多选悬浮栏（#180）", () => {
  it("用 Dock 显示“已选 N 张”和只有图标的操作，悬停看标签", async () => {
    backend();
    const { bar } = renderBar();
    expect(bar.classList.contains("k-dock")).toBe(true);
    expect(within(bar).getByText("已选 2 张")).toBeTruthy();
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label")))
      .toEqual(["放入文件夹", "删除，Del", "取消选择"]);
    expect(bar.querySelector(".k-dock-item")?.textContent).toBe("");
    await waitFor(() => expect(within(bar).getByRole("button", { name: "放入文件夹" })).toHaveProperty("disabled", false));
  });

  it("放入文件夹弹出文件夹菜单，选中后放入；删除后取消选择", async () => {
    const edits = backend();
    const { bar, onClear } = renderBar();
    const put = within(bar).getByRole("button", { name: "放入文件夹" });
    await waitFor(() => expect(put).toHaveProperty("disabled", false));
    fireEvent.click(put);
    fireEvent.click(await screen.findByRole("menuitem", { name: /发型/ }));
    await waitFor(() => expect(edits).toEqual([{ libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "addToFolder", folderId: "F2" }] }]));
    expect(onClear).not.toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole("button", { name: "删除，Del" }));
    await waitFor(() => expect(edits.at(-1)).toEqual({ libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "delete" }] }));
    await waitFor(() => expect(onClear).toHaveBeenCalled());
  });

  it("没有文件夹时“放入文件夹”禁用", async () => {
    backend([]);
    const { bar } = renderBar();
    await waitFor(() => expect(bar.querySelector('[data-dock-id="put"] .k-dock-item')).toBeTruthy());
    expect(within(bar).getByRole("button", { name: "放入文件夹" })).toHaveProperty("disabled", true);
  });

  it("文件夹浏览范围里多一项“移出此文件夹”", async () => {
    const edits = backend();
    const { bar } = renderBar({ kind: "folder", id: "F1" });
    fireEvent.click(within(bar).getByRole("button", { name: "移出此文件夹" }));
    await waitFor(() => expect(edits).toEqual([{ libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "removeFromFolder", folderId: "F1" }] }]));
  });

  it("回收站范围是恢复和永久删除…", async () => {
    const edits = backend();
    const { bar } = renderBar({ kind: "trash" });
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["恢复", "永久删除…", "取消选择"]);
    fireEvent.click(within(bar).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(edits).toEqual([{ libraryId: "L1", ids: ["a", "b"], edits: [{ kind: "restore" }] }]));
    fireEvent.click(within(bar).getByRole("button", { name: "永久删除…" }));
    expect(await screen.findByRole("alertdialog", { name: "永久删除" })).toBeTruthy();
  });
});

describe("很窄的图片墙（#180）", () => {
  it("紧凑时读数只写“N 张”，读屏仍是“已选 N 张”；报告宽度时标明是紧凑的", () => {
    backend();
    const onWidth = vi.fn();
    render(<SelectionBar compact libraryId="L1" scope={{ kind: "all" }} ids={["a", "b"]} onClear={() => {}} reloadKey={0} onError={() => {}} left={0} onWidth={onWidth} />);
    const bar = screen.getByRole("toolbar", { name: "已选参考图操作" });
    expect(bar.classList.contains("is-compact")).toBe(true);
    expect(within(bar).getByLabelText("已选 2 张").textContent).toBe("2 张");
    expect(onWidth).toHaveBeenCalledWith(expect.any(Number), true);
  });
});
