import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createRef } from "react";
import { ImportMenu, type ImportControl } from "./ImportMenu";
import { SaveDestinationProvider } from "./SaveDestination";

afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); clearMocks(); });

it("图片墙右键的“导入 ▸”与导入按钮走同一入口：选图片文件、选文件夹", async () => {
  mockWindows("main");
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "plugin:library|import_tasks") return [];
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:library|pick_files") return [];
    if (cmd === "plugin:library|pick_folder") return null;
    return undefined;
  });
  const control = createRef<ImportControl>();
  render(<ImportMenu control={control} enabled libraryId="L1" libraryName="参考" running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />);
  await waitFor(() => expect(control.current).not.toBeNull());
  await act(async () => control.current!.files());
  await waitFor(() => expect(calls).toContain("plugin:library|pick_files"));
  await act(async () => control.current!.folder());
  await waitFor(() => expect(calls).toContain("plugin:library|pick_folder"));
});

it("从剪贴板导入（#105）：剪贴板图片暂存成文件后走同一导入流程，保存位置照常明确选择", async () => {
  mockWindows("main");
  const libraries = [{ library: { id: "A", name: "浏览库", root: "C:/a" }, unavailable: null }, { library: { id: "B", name: "保存库", root: "D:/b" }, unavailable: null }];
  let submitted: unknown = null;
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_directories") return { status: { revision: "t", libraries }, providers: libraries.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) };
    if (cmd === "plugin:library|import_tasks") return [];
    if (cmd === "plugin:library|recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:desktop|stage_clipboard_import") return "C:/data/clipboard-import/剪贴板图片-1.png";
    if (cmd === "plugin:library|import_contains_eagle") return false;
    if (cmd === "plugin:library|start_import") { submitted = args; return "clip-task"; }
    return null;
  }, { shouldMockEvents: true });
  const control = createRef<ImportControl>();
  render(<SaveDestinationProvider safe><ImportMenu control={control} enabled libraryId="A" libraryName="浏览库" running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} /></SaveDestinationProvider>);
  await waitFor(() => expect(control.current).not.toBeNull());
  await act(async () => control.current!.clipboard());
  const start = await screen.findByRole("button", { name: "开始导入" });
  const dialog = screen.getByRole("dialog", { name: "导入图片" });
  expect(within(dialog).getByText("剪贴板图片-1.png")).toBeTruthy();
  // 没有明确选择保存位置之前不开始。
  expect(start).toHaveProperty("disabled", true);
  expect(submitted).toBeNull();
  fireEvent.change(await within(dialog).findByRole("combobox", { name: "放到图库" }), { target: { value: "B" } });
  await waitFor(() => expect(start).toHaveProperty("disabled", false));
  fireEvent.click(start);
  await waitFor(() => expect(submitted).toMatchObject({ libraryId: "B", destination: { libraryId: "B", folderId: null }, source: { paths: ["C:/data/clipboard-import/剪贴板图片-1.png"] } }));
});

it("从剪贴板导入：剪贴板没有图片时报告原因，不打开导入对话框", async () => {
  mockWindows("main");
  mockIPC((cmd) => {
    if (cmd === "plugin:library|import_tasks") return [];
    if (cmd === "plugin:library|recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:desktop|stage_clipboard_import") throw "剪贴板里没有图片";
    return null;
  });
  const control = createRef<ImportControl>();
  render(<ImportMenu control={control} enabled libraryId="L1" libraryName="参考" running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />);
  await waitFor(() => expect(control.current).not.toBeNull());
  await expect(control.current!.clipboard()).rejects.toBe("剪贴板里没有图片");
  expect(screen.queryByRole("button", { name: "开始导入" })).toBeNull();
});
