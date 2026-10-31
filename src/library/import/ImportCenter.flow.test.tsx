import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { createRef } from "react";
import type { ImportReport } from "../../bindings/ImportReport";
import { ImportCenter, type ImportControl } from "./ImportCenter";
import { SaveDestinationProvider } from "../SaveDestination";
import { chooseOption } from "../../test/select";

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  vi.unstubAllGlobals();
});

const report: ImportReport = { items: [], cancelled: false, fromEagle: false, eagleMissing: 0, eagleRelocations: [], sealedDuplicates: false, privateSummary: false, trashDuplicates: false };
const sealed: ImportReport = { ...report, sealedDuplicates: true, privateSummary: true };
const main = { library: { id: "L1", name: "参考", root: "C:/a" }, unavailable: null };

function backend(more?: (cmd: string, args: unknown) => unknown) {
  mockWindows("main");
  mockIPC((cmd, args) => {
    const answer = more?.(cmd, args);
    if (answer !== undefined) return answer;
    if (cmd === "plugin:library|import_tasks") return [];
    if (cmd === "plugin:library|workspace_directories") return { status: { revision: "t", libraries: [main] }, providers: [{ registration: main, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} }] };
    if (cmd === "plugin:library|import_contains_eagle") return false;
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:library|discover_eagle_libraries")
      return [{ name: "主库", path: "D:/Eagle/主库.library", items: 3, version: "4.0.0", foundBy: "settings" }];
    if (cmd === "plugin:library|start_import") return "task-1";
    if (cmd === "plugin:library|eagle_tag_mapping") return { matched: [], unmatched: [], vocabularySize: 0 };
    return undefined;
  }, { shouldMockEvents: true });
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
}

/** 图片墙右键与 Ctrl O 经 `control` 调用导入；测试同样经它调用。 */
const control = createRef<ImportControl>() as { current: ImportControl | null };
/** 从 Eagle 导入：选“主库”，在导入对话框里明确选好保存位置。 */
const eaglePlan = async () => {
  await act(() => { control.current!.eagle(); });
  fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
  const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
  await chooseOption(await within(plan).findByRole("combobox", { name: "放到图库" }), /^参考/);
  return plan;
};

function center({ report, taskId = "task-1", libraryId = "L1" }: { report: ImportReport | null; taskId?: string; libraryId?: string }) {
  // 测试里启动命令总是返回 task-1，结束的也是它。
  const finished = report && { taskId, report };
  return <ImportCenter control={control} enabled libraryId={libraryId} running={null} finished={finished} onStarted={() => {}} onDismissReport={() => {}} />;
}
/** 打开弹层，展开唯一的一条回执，点“有封印项重复，是否展开看看”。 */
const showSealed = async () => {
  if (!screen.queryByRole("dialog", { name: "导入" })) fireEvent.click(screen.getByRole("button", { name: /^(导入|正在导入)$/ }));
  const toggle = await screen.findByRole("button", { name: /，导入完成$/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  fireEvent.click(await screen.findByRole("button", { name: "有封印项重复，是否展开看看" }));
};

describe("Eagle 迁入后的标签外部对应", () => {
  it("通用入口被后端识别为 Eagle 时，也进入标签对应步骤且只打开一次", async () => {
    backend();
    const { rerender } = render(center({ report: null }));
    const detected = { ...report, fromEagle: true };
    rerender(center({ report: detected }));
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    rerender(center({ report: { ...detected } }));
    expect(screen.queryByRole("region", { name: "标签的外部对应" })).toBeNull();
  });

  it("从 Eagle 迁入完成后进入这一步；开始后对话框连同遮罩一起关闭（#98 本机 r12）", async () => {
    backend();
    const { rerender } = render(<SaveDestinationProvider safe>{center({ report: null })}</SaveDestinationProvider>);
    const plan = await eaglePlan();
    expect((await within(plan).findByRole<HTMLInputElement>("radio", { name: /继续跳过/ })).checked).toBe(true);
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "从 Eagle 导入" })).toBeNull());
    // 留下的遮罩会盖住整个窗口、吃掉所有点按。
    await waitFor(() => expect(document.querySelector(".k-backdrop")).toBeNull());
    rerender(<SaveDestinationProvider safe>{center({ report })}</SaveDestinationProvider>);
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
  });

  it("普通导入完成后不显示这一步", async () => {
    backend();
    const { rerender } = render(center({ report: null }));
    rerender(center({ report }));
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    await screen.findByRole("button", { name: "导入，导入完成" });
    expect(screen.queryByRole("region", { name: "标签的外部对应" })).toBeNull();
  });

  it("Eagle 的删过的图默认继续跳过，选“这次也导入”只对这次任务生效", async () => {
    const started: unknown[] = [];
    backend((cmd, args) => { if (cmd === "plugin:library|start_import") { started.push(args); return "task-1"; } return undefined; });
    render(<SaveDestinationProvider safe>{center({ report: null })}</SaveDestinationProvider>);
    const plan = await eaglePlan();
    expect(within(plan).getByText("原库不会改动。")).toBeTruthy();
    const skip = within(plan).getByRole<HTMLInputElement>("radio", { name: /继续跳过.*之前删掉的不再导入/ });
    const once = within(plan).getByRole<HTMLInputElement>("radio", { name: /这次也导入.*只对这一次有效/ });
    expect(skip.checked).toBe(true);
    fireEvent.click(once);
    expect(once.checked).toBe(true);
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ options: { eagleDeletedContent: "allowThisImport" } });
  });
});

describe("封印重复项回执（#78）", () => {
  it("只提示存在封印重复项，不显示成功项数量或内容，也不做悬停子菜单", async () => {
    backend();
    render(center({ report: sealed }));
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    fireEvent.click(await screen.findByRole("button", { name: "导入，导入完成" }));
    const row = await screen.findByRole("region", { name: "导入回执：导入" });
    expect(within(row).getByText("内容处理结果已保留")).toBeTruthy();
    expect(row.textContent).not.toMatch(/新增|已存在/);
    const ask = within(row).getByRole("button", { name: "有封印项重复，是否展开看看" });
    expect(ask.getAttribute("aria-haspopup")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("展开后是界面系统的对话框：标题与说明用规格原话，关闭按钮可用", async () => {
    backend((cmd) => cmd === "plugin:library|open_import_preview" ? { id: "session", items: [] } : undefined);
    render(center({ report: sealed }));
    await showSealed();
    const dialog = await screen.findByRole("dialog", { name: "本次封印重复项" });
    expect(dialog.className).toContain("k-dialog");
    expect(dialog.tagName).not.toBe("DIALOG");
    expect(dialog.textContent).toContain("只展开本次重复项");
    expect(dialog.textContent).toContain("关闭后重新遮蔽");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭重复项预览" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull());
  });

  it("关闭期间迟到的预览字节不会创建图片，且回执仍需重新明确展开", async () => {
    const calls: string[] = [];
    let release!: () => void, channel: Channel<ArrayBuffer> | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    backend((cmd, args) => {
      calls.push(cmd);
      if (cmd === "plugin:library|open_import_preview") return { id: "receipt-session", items: ["opaque-item"] };
      if (cmd === "plugin:library|read_import_preview") { channel = (args as { onChunk: Channel<ArrayBuffer> }).onChunk; return pending; }
      return undefined;
    });
    const create = vi.fn(() => "blob:preview");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    const { rerender } = render(center({ report: sealed }));
    await showSealed();
    await waitFor(() => expect(calls).toContain("plugin:library|read_import_preview"));
    fireEvent.click(screen.getByRole("button", { name: "关闭重复项预览" }));
    await waitFor(() => expect(calls).toContain("plugin:library|close_import_preview"));
    channel!.onmessage(new Uint8Array([137, 80, 78, 71]).buffer);
    channel!.onmessage(new ArrayBuffer(0));
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
    rerender(center({ report: { ...sealed } }));
    expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
  });

  it("新结束的回执不会沿用前一张回执的明确同意", async () => {
    const opened: string[] = [];
    backend((cmd, args) => { if (cmd === "plugin:library|open_import_preview") { opened.push((args as { taskId: string }).taskId); return { id: "session", items: [] }; } return undefined; });
    const { rerender } = render(center({ report: sealed, taskId: "task-first" }));
    await showSealed();
    await waitFor(() => expect(opened).toEqual(["task-first"]));
    fireEvent.click(await screen.findByRole("button", { name: "关闭重复项预览" }));
    rerender(center({ report: sealed, taskId: "task-next" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened).toEqual(["task-first"]);
    expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
  });

  for (const phase of ["已显示图片", "读取尚未完成"] as const) it(`当前图库改变立即遮蔽${phase}，回执仍在、要再次同意`, async () => {
    const closed: string[] = [];
    let channel: Channel<ArrayBuffer> | undefined, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    backend((cmd, args) => {
      if (cmd === "plugin:library|open_import_preview") return { id: "actual-receipt-session", items: ["opaque-item"] };
      if (cmd === "plugin:library|read_import_preview") {
        channel = (args as { onChunk: Channel<ArrayBuffer> }).onChunk;
        if (phase === "读取尚未完成") return pending;
        channel.onmessage(new Uint8Array([137, 80, 78, 71]).buffer);
        channel.onmessage(new ArrayBuffer(0));
        return null;
      }
      if (cmd === "plugin:library|close_import_preview") { closed.push((args as { sessionId: string }).sessionId); return null; }
      return undefined;
    });
    const revoke = vi.fn(), create = vi.fn(() => "blob:actual-receipt-preview");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const { rerender } = render(center({ report: sealed }));
    await showSealed();
    if (phase === "已显示图片") expect(await screen.findByRole("img", { name: "本次导入的重复项" })).toBeTruthy();
    else await waitFor(() => expect(channel).toBeDefined());
    rerender(center({ report: sealed, libraryId: "L2" }));
    expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(closed).toContain("actual-receipt-session"));
    if (phase === "已显示图片") expect(revoke).toHaveBeenCalledWith("blob:actual-receipt-preview");
    else {
      await act(async () => {
        channel!.onmessage(new Uint8Array([137, 80, 78, 71]).buffer); channel!.onmessage(new ArrayBuffer(0)); release(); await pending;
      });
      expect(create).not.toHaveBeenCalled();
      expect(screen.queryByRole("img")).toBeNull();
    }
    rerender(center({ report: sealed }));
    expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull();
    await showSealed();
    expect(await screen.findByRole("dialog", { name: "本次封印重复项" })).toBeTruthy();
  });
});

describe("别处的入口", () => {
  it("图片墙右键的“导入 ▸”与导入按钮走同一入口：选图片文件、选文件夹", async () => {
    const calls: string[] = [];
    backend((cmd) => {
      calls.push(cmd);
      if (cmd === "plugin:library|pick_files") return [];
      if (cmd === "plugin:library|pick_folder") return null;
      return undefined;
    });
    render(center({ report: null }));
    await waitFor(() => expect(control.current).not.toBeNull());
    await act(async () => control.current!.files());
    await waitFor(() => expect(calls).toContain("plugin:library|pick_files"));
    await act(async () => control.current!.folder());
    await waitFor(() => expect(calls).toContain("plugin:library|pick_folder"));
  });

  it("从剪贴板导入（#105）：剪贴板图片暂存成文件后走同一导入流程，保存位置照常明确选择", async () => {
    const libraries = [{ library: { id: "A", name: "浏览库", root: "C:/a" }, unavailable: null }, { library: { id: "B", name: "保存库", root: "D:/b" }, unavailable: null }];
    let submitted: unknown = null;
    backend((cmd, args) => {
      if (cmd === "plugin:library|workspace_directories") return { status: { revision: "t", libraries }, providers: libraries.map((registration) => ({ registration, sidebar: { all: 0, trash: 0, folders: [] }, unassigned: 0, descendants: {} })) };
      if (cmd === "plugin:desktop|stage_clipboard_import") return "C:/data/clipboard-import/剪贴板图片-1.png";
      if (cmd === "plugin:library|import_contains_eagle") return false;
      if (cmd === "plugin:library|start_import") { submitted = args; return "clip-task"; }
      return undefined;
    });
    render(<SaveDestinationProvider safe>{center({ report: null, libraryId: "A" })}</SaveDestinationProvider>);
    await waitFor(() => expect(control.current).not.toBeNull());
    await act(async () => control.current!.clipboard());
    const start = await screen.findByRole("button", { name: "开始导入" });
    const dialog = screen.getByRole("dialog", { name: "导入图片" });
    expect(within(dialog).getByText("剪贴板图片-1.png")).toBeTruthy();
    // 没有明确选择保存位置之前不开始。
    expect(start).toHaveProperty("disabled", true);
    expect(submitted).toBeNull();
    await chooseOption(await within(dialog).findByRole("combobox", { name: "放到图库" }), /^保存库/);
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
    fireEvent.click(start);
    await waitFor(() => expect(submitted).toMatchObject({ libraryId: "B", destination: { libraryId: "B", folderId: null }, source: { paths: ["C:/data/clipboard-import/剪贴板图片-1.png"] } }));
  });

  it("从剪贴板导入：剪贴板没有图片时报告原因，不打开导入对话框", async () => {
    backend((cmd) => { if (cmd === "plugin:desktop|stage_clipboard_import") throw "剪贴板里没有图片"; return undefined; });
    render(center({ report: null }));
    await waitFor(() => expect(control.current).not.toBeNull());
    await expect(control.current!.clipboard()).rejects.toBe("剪贴板里没有图片");
    expect(screen.queryByRole("button", { name: "开始导入" })).toBeNull();
  });
});
