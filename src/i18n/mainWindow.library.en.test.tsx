import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { i18n } from ".";
import { LibraryPicker } from "../library/LibraryPicker";
import { CreateLibrary } from "../library/CreateLibrary";
import { WorkspacePane } from "../library/WorkspacePane";
import { TagGroupBar } from "../search/TagGroupBar";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下首次启动、资料库侧栏与标签分组栏没有中文界面文案（#356）；图库名、文件夹名与标签名是画师的数据。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  cleanup();
  await act(async () => {});
  clearMocks();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const registrations = ["A", "B"].map((id) => ({ library: { id, name: `库${id}`, root: `D:\\${id}` }, unavailable: null as string | null }));
const forest = (): WorkspaceDirectories => ({
  status: { revision: "r", libraries: registrations },
  providers: registrations.map((registration) => ({
    registration, unassigned: 1, descendants: {},
    sidebar: { all: 3, trash: 2, folders: [{ id: `${registration.library.id}-f`, name: "人物", count: 1, children: [{ id: `${registration.library.id}-c`, name: "动作", count: 1, children: [] }] }] },
  })),
});
const data = ["库A", "库B", "人物", "动作", "眼睛", "蓝瞳"];

describe("英文界面：首次启动", () => {
  it("欢迎页与新建图库", async () => {
    mockIPC(() => [], { shouldMockEvents: true });
    render(<LibraryPicker layout="inline" current={null} onChanged={vi.fn()} onCreate={vi.fn()} />);
    await settle();
    expect(screen.getByRole("heading", { name: "Welcome to Kinshoko" })).toBeTruthy();
    expectNoChinese(document.body);
    cleanup();
    render(<CreateLibrary onCreated={vi.fn()} onBack={vi.fn()} backLabel="Back" />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("My references");
    expectNoChinese(document.body);
  });
});

describe("英文界面：资料库与文件夹树", () => {
  it("查找范围、图库标题、文件夹、未归类与回收站", async () => {
    mockIPC((command) => (command === "plugin:library|workspace_directories" ? forest() : null), { shouldMockEvents: true });
    render(<WorkspacePane status={{ revision: "r", libraries: registrations }} scope={{ kind: "library", libraryId: "A", scope: { kind: "folder", id: "A-f" } }}
      safeMode reloadKey={0} onScope={vi.fn()} onError={vi.fn()} />);
    await settle(); await settle();
    expect(screen.getByRole("button", { name: "库A (3 images)" })).toBeTruthy();
    expectNoChinese(document.body, data);
    fireEvent.click(screen.getByRole("button", { name: "Actions for 库A" }));
    expect(await screen.findByRole("menuitem", { name: "Remove from list" })).toBeTruthy();
    expectNoChinese(document.body, data);
  });

  it("管理图库", async () => {
    mockIPC((command) => (command === "plugin:library|registered_libraries" ? registrations : null), { shouldMockEvents: true });
    render(<LibraryPicker current={registrations[0].library} onChanged={vi.fn()} onCreate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open, create or manage libraries" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage libraries" }));
    expect(await screen.findByRole("button", { name: "Remove 库A" })).toBeTruthy();
    expectNoChinese(document.body, data);
  });
});

describe("英文界面：标签分组栏", () => {
  it("分组与任一成员", async () => {
    mockIPC((command) => command === "plugin:library|tag_groups"
      ? [{ id: "g", name: "眼睛", namespace: null, tags: [{ tag: { id: "t", name: "蓝瞳", namespace: "general", untranslated: false, hasExternal: false }, count: 2 }] }]
      : null, { shouldMockEvents: true });
    render(<TagGroupBar libraryId="lib" safe={false} generation={0} input={{ conditions: [], exact: false }} onChange={vi.fn()} onError={vi.fn()} onEdit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /眼睛/ }));
    expect(screen.getByRole("button", { name: "Search for any tag in “眼睛”" })).toBeTruthy();
    expectNoChinese(document.body, data);
  });
});
