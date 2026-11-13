import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { ImportMenu, type ImportControl } from "./ImportMenu";
import { SaveDestinationProvider } from "./SaveDestination";
import { fakeBackend } from "../test/backend";
import { chooseOption } from "../test/select";

it("图片墙右键的“导入 ▸”与导入按钮走同一入口：选图片文件、选文件夹", async () => {
  const fake = fakeBackend({
    import_tasks: [],
    pick_files: [],
    pick_folder: null,
  });
  const calls = () => fake.calls().map((call) => call.command);
  const control = createRef<ImportControl>();
  render(<ImportMenu control={control} enabled running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />);
  await waitFor(() => expect(control.current).not.toBeNull());
  await act(async () => control.current!.files());
  await waitFor(() => expect(calls()).toContain("pick_files"));
  await act(async () => control.current!.folder());
  await waitFor(() => expect(calls()).toContain("pick_folder"));
});

it("从剪贴板导入（#105）：剪贴板图片暂存成文件后走同一导入流程，先确认保存位置", async () => {
  const libraries = [{ library: { id: "A", name: "浏览库", root: "C:/a" }, unavailable: null }, { library: { id: "B", name: "保存库", root: "D:/b" }, unavailable: null }];
  let submitted: unknown = null;
  fakeBackend({
    workspace_directories: { status: { revision: "t", libraries }, registrationOrder: [], providers: libraries.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) },
    import_tasks: [],
    recovery: { interrupted: [], orphans: [] },
    stage_clipboard_import: "C:/data/clipboard-import/剪贴板图片-1.png",
    import_contains_eagle: false,
    start_import: (args) => { submitted = args; return "clip-task"; },
  });
  const control = createRef<ImportControl>();
  render(<SaveDestinationProvider safe><ImportMenu control={control} enabled running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} /></SaveDestinationProvider>);
  await waitFor(() => expect(control.current).not.toBeNull());
  await act(async () => control.current!.clipboard());
  const start = await screen.findByRole("button", { name: "开始导入" });
  const dialog = screen.getByRole("dialog", { name: "导入图片" });
  expect(within(dialog).getByText("剪贴板图片-1.png")).toBeTruthy();
  // 确认之前不开始。
  expect(submitted).toBeNull();
  await chooseOption(await within(dialog).findByRole("combobox", { name: "放到图库" }), /^保存库/);
  await waitFor(() => expect(start).toHaveProperty("disabled", false));
  fireEvent.click(start);
  await waitFor(() => expect(submitted).toMatchObject({ libraryId: "B", destination: { libraryId: "B", folderId: null }, source: { paths: ["C:/data/clipboard-import/剪贴板图片-1.png"] } }));
});

it("从剪贴板导入：剪贴板没有图片时报告原因，不打开导入对话框", async () => {
  fakeBackend({
    import_tasks: [],
    stage_clipboard_import: () => { throw "剪贴板里没有图片"; },
  });
  const control = createRef<ImportControl>();
  render(<ImportMenu control={control} enabled running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />);
  await waitFor(() => expect(control.current).not.toBeNull());
  await expect(control.current!.clipboard()).rejects.toBe("剪贴板里没有图片");
  expect(screen.queryByRole("button", { name: "开始导入" })).toBeNull();
});
