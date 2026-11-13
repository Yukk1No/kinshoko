import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import type { SaveMemory } from "../bindings/SaveMemory";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { fakeBackend } from "../test/backend";
import { chooseOption } from "../test/select";
import { ImportMenu, type ImportControl } from "./ImportMenu";
import { SaveDestinationProvider } from "./SaveDestination";

const libraries = [
  { library: { id: "A", name: "最早库", root: "C:/a" }, unavailable: null },
  { library: { id: "B", name: "第二库", root: "D:/b" }, unavailable: null },
];
const folders = [{ id: "fb", name: "人物", count: 0, children: [] }];

function setup({ scope = { kind: "all" }, memory = { importDestination: null, newLibraryParent: null }, listed = libraries }: { scope?: WorkspaceScope; memory?: SaveMemory; listed?: typeof libraries } = {}) {
  const started: unknown[] = [], remembered: unknown[] = [];
  let next = 0;
  fakeBackend({
    workspace_directories: { status: { revision: "t", libraries }, registrationOrder: libraries.map((entry) => entry.library.id), providers: listed.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders }, unassigned: 0, descendants: {} })) },
    save_memory: memory,
    remember_import_destination: (args) => { remembered.push(args.destination); return null; },
    import_tasks: [],
    recovery: { interrupted: [], orphans: [] },
    stage_clipboard_import: "C:/data/剪贴板.png",
    import_contains_eagle: false,
    start_import: (args) => { started.push(args.destination); return `T${++next}`; },
  });
  const control = createRef<ImportControl>();
  const ui = (value: WorkspaceScope) => <><SaveDestinationProvider safe={false}><ImportMenu control={control} scope={value} enabled running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} /></SaveDestinationProvider></>;
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

it("登记最早看登记先后，不看目录接口返回的顺序", async () => {
  const { open } = setup({ listed: [...libraries].reverse() });
  const dialog = await open();
  await within(dialog).findByText("放到：最早库 / 未归类");
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
