import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { SaveMemory } from "../bindings/SaveMemory";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { chooseOption } from "../test/select";
import { ToastProvider } from "../ui/Toast";
import { ImportMenu, type ImportControl } from "./ImportMenu";
import { SaveDestinationProvider } from "./SaveDestination";

afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); clearMocks(); });

const libraries = [
  { library: { id: "A", name: "最早库", root: "C:/a" }, unavailable: null },
  { library: { id: "B", name: "第二库", root: "D:/b" }, unavailable: null },
];
const folders = [{ id: "fb", name: "人物", count: 0, children: [] }];

function setup({ scope = { kind: "all" }, memory = { importDestination: null, newLibraryParent: null } }: { scope?: WorkspaceScope; memory?: SaveMemory } = {}) {
  const started: unknown[] = [], remembered: unknown[] = [];
  let next = 0;
  mockWindows("main");
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|workspace_directories") return { status: { revision: "t", libraries }, providers: libraries.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders }, unassigned: 0, descendants: {} })) };
    if (cmd === "plugin:library|save_memory") return memory;
    if (cmd === "plugin:library|remember_import_destination") { remembered.push((args as { destination: unknown }).destination); return null; }
    if (cmd === "plugin:library|import_tasks") return [];
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:desktop|stage_clipboard_import") return "C:/data/剪贴板.png";
    if (cmd === "plugin:library|import_contains_eagle") return false;
    if (cmd === "plugin:library|start_import") { started.push((args as { destination: unknown }).destination); return `T${++next}`; }
    return null;
  }, { shouldMockEvents: true });
  const control = createRef<ImportControl>();
  const ui = (value: WorkspaceScope) => <ToastProvider><SaveDestinationProvider safe={false}><ImportMenu control={control} scope={value} enabled running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} /></SaveDestinationProvider></ToastProvider>;
  const view = render(ui(scope));
  const open = async () => {
    await waitFor(() => expect(control.current).not.toBeNull());
    await act(async () => control.current!.clipboard());
    return screen.findByRole("dialog", { name: "导入图片" });
  };
  const confirm = async (dialog: HTMLElement) => {
    const start = within(dialog).getByRole("button", { name: "开始导入" });
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
    fireEvent.click(start);
  };
  return { started, remembered, open, confirm, rerender: (value: WorkspaceScope) => view.rerender(ui(value)) };
}

it("「全部图片」下没记过时，预填登记最早的可用资料库的未归类；照预填确认不写进记忆", async () => {
  const { open, confirm, started, remembered } = setup();
  const dialog = await open();
  await within(dialog).findByText("放到：最早库 / 未归类");
  await confirm(dialog);
  await waitFor(() => expect(started).toEqual([{ libraryId: "A", folderId: null }]));
  expect(remembered).toEqual([]);
});

it("「全部图片」下用导入上次亲手选的保存目标", async () => {
  const { open, confirm, started } = setup({ memory: { importDestination: { libraryId: "B", folderId: "fb" }, newLibraryParent: null } });
  const dialog = await open();
  await within(dialog).findByText("放到：第二库 / 人物");
  await confirm(dialog);
  await waitFor(() => expect(started).toEqual([{ libraryId: "B", folderId: "fb" }]));
});

it("在对话框里亲手选的写进记忆，下一次导入预填它", async () => {
  const { open, confirm, started, remembered } = setup();
  const dialog = await open();
  await chooseOption(await within(dialog).findByRole("combobox", { name: "放到图库" }), /^第二库/);
  await confirm(dialog);
  await waitFor(() => expect(remembered).toEqual([{ libraryId: "B", folderId: null }]));
  expect(started).toEqual([{ libraryId: "B", folderId: null }]);
});

it("在文件夹里导入预填这个文件夹，只用这一次，不写进记忆", async () => {
  const { open, confirm, started, remembered } = setup({
    scope: { kind: "library", libraryId: "B", scope: { kind: "folder", id: "fb" } },
    memory: { importDestination: { libraryId: "A", folderId: null }, newLibraryParent: null },
  });
  const dialog = await open();
  await within(dialog).findByText("放到：第二库 / 人物");
  await confirm(dialog);
  await waitFor(() => expect(started).toEqual([{ libraryId: "B", folderId: "fb" }]));
  expect(remembered).toEqual([]);
});

it("在资料库的全部里导入放进它的未归类", async () => {
  const { open } = setup({ scope: { kind: "library", libraryId: "B", scope: { kind: "all" } } });
  const dialog = await open();
  await within(dialog).findByText("放到：第二库 / 未归类");
});

it("取消后换了浏览范围，下一次按新范围预填，不留上次对话框里选的", async () => {
  const { open, rerender, remembered } = setup();
  const dialog = await open();
  await chooseOption(await within(dialog).findByRole("combobox", { name: "放到图库" }), /^第二库/);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "导入图片" })).toBeNull());

  rerender({ kind: "library", libraryId: "A", scope: { kind: "all" } });
  const again = await open();
  await within(again).findByText("放到：最早库 / 未归类");
  expect(remembered).toEqual([]);
});
