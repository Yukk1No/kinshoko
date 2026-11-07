import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { act } from "react";
import { App } from "./App";
import { backend, clean, library, push, selectionBar, sent } from "./App.fixtures";

/** ADR-0008：界面没有“窗口打开的资料库”，后端按需切换可写句柄不影响界面状态。 */
describe("A 库导入中，整理 B 库文件夹", () => {
  const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const importing = {
    taskId: "T1", destination: { libraryId: "L1", folderId: null }, libraryName: library.name, folderName: null,
    progress: { done: 1, total: 5 }, report: null, finishing: false, warnings: [],
  };

  async function organizeInB() {
    let tasks: unknown[] = [importing];
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      if (cmd === "plugin:library|import_tasks") return tasks;
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(await screen.findByRole("button", { name: "私人收藏（2 张）" }));
    await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2" }));
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(card("b"), { ctrlKey: true });
    await waitFor(() => expect(selectionBar()).toBeTruthy());
    return { finishTasks: (value: unknown[]) => { tasks = value; } };
  }

  it("整理请求带着 B；可写句柄切到 B 后，范围、选择和 A 的进度都不动", async () => {
    await organizeInB();
    await screen.findByText(`放到 ${library.name} / 未归类`);

    fireEvent.click(screen.getByRole("button", { name: "移到文件夹" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /发型/ }));
    await waitFor(() => expect(sent("plugin:library|edit")).toEqual([
      { libraryId: "L2", ids: ["a", "b"], edits: [{ kind: "addToFolder", folderId: "F2" }] },
    ]));

    await act(() => emit("writable-library", other));
    await push({ kind: "taskProgress", libraryId: "L1", taskId: "T1", progress: { done: 2, total: 5 } });

    expect(within(selectionBar()!).getByText("已选 2 张")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "导入进度" })).getByText("2 / 5")).toBeTruthy();
    expect(screen.getByText(`放到 ${library.name} / 未归类`)).toBeTruthy();
    expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2" });
  });

  it("等 A 的导入收尾时只给轻提示，A 的结果回执照样归 A", async () => {
    const { finishTasks } = await organizeInB();
    await screen.findByText(`放到 ${library.name} / 未归类`);

    await act(() => emit("organize-waiting", { finishing: [library.name] }));
    expect(await screen.findByText("导入完成后再整理")).toBeTruthy();

    finishTasks([]);
    const report = { cancelled: true, items: [], fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: false, eagleMissing: 0, eagleRelocations: [] };
    await push({ kind: "taskFinished", libraryId: "L1", taskId: "T1", report });

    await waitFor(() => expect(screen.queryByRole("region", { name: "导入进度" })).toBeNull());
    expect(within(selectionBar()!).getByText("已选 2 张")).toBeTruthy();
    expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2" });
  });

  it("B 的句柄与 A 的句柄各确认一次安全模式：只算一次", async () => {
    await organizeInB();

    await push({ kind: "safeModeChanged", libraryId: "L1", on: true });
    await waitFor(() => expect(selectionBar()).toBeNull());
    await waitFor(() => expect(card("a")).toBeTruthy());
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(card("b"), { ctrlKey: true });
    await waitFor(() => expect(selectionBar()).toBeTruthy());

    await push({ kind: "safeModeChanged", libraryId: "L2", on: true });

    expect(selectionBar()).toBeTruthy();
  });

  it("回收站按回执所属的图库打开，不用缺省图库", async () => {
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");

    const report = { cancelled: false, items: [], fromEagle: false, sealedDuplicates: false, privateSummary: false, trashDuplicates: true, eagleMissing: 0, eagleRelocations: [] };
    await push({ kind: "taskFinished", libraryId: "L2", taskId: "T9", report });
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "去回收站" }));

    await waitFor(() => expect(sent("plugin:library|browse").at(-1)).toMatchObject({ libraryId: "L2", query: { scope: { kind: "trash" } } }));
  });
});
