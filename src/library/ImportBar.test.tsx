import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { ImportReport } from "../bindings/ImportReport";
import { createRef } from "react";
import { ImportBar, type ImportActions } from "./ImportBar";

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

const report: ImportReport = { items: [], cancelled: false, fromEagle: false, eagleMissing: 0, eagleRelocations: [], sealedDuplicates: false, privateSummary: false, trashDuplicates: false };

function backend() {
  mockWindows("main");
  mockIPC((cmd) => {
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:library|discover_eagle_libraries")
      return [{ name: "主库", path: "D:/Eagle/主库.library", items: 3, version: "4.0.0", foundBy: "settings" }];
    if (cmd === "plugin:library|start_import") return "task-1";
    if (cmd === "plugin:library|eagle_tag_mapping") return { matched: [], unmatched: [], vocabularySize: 0 };
    return undefined;
  }, { shouldMockEvents: true });
}

/** 导入入口在顶栏的分体按钮里（#98），它经 `actionsRef` 调用导入栏；测试同样经它调用。 */
const actions = createRef<ImportActions>() as { current: ImportActions | null };
const fromEagle = () => act(() => { actions.current!.eagle(); });

function bar(props: { report: ImportReport | null }) {
  // 测试里启动命令总是返回 task-1，结束的也是它。
  const finished = props.report && { taskId: "task-1", report: props.report };
  return (
    <ImportBar
      actionsRef={actions}
      enabled
      libraryId="L1"
      libraryName="参考"
      running={null}
      finished={finished}
      onStarted={() => {}}
      onDismissReport={() => {}}
    />
  );
}

describe("导入栏：Eagle 迁入后的标签外部对应", () => {
  it("通用入口被后端识别为 Eagle 时，也进入标签对应步骤且只打开一次", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    const detected = { ...report, fromEagle: true };
    rerender(bar({ report: detected }));
    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    rerender(bar({ report: { ...detected } }));
    expect(screen.queryByRole("region", { name: "标签的外部对应" })).toBeNull();
  });

  it("从 Eagle 迁入完成后进入“标签的外部对应”一步", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    await fromEagle();
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
    expect((await screen.findByRole<HTMLInputElement>("radio", { name: /继续跳过/ })).checked).toBe(true);
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    // 迁入开始后选择资料库的面板收起。
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "从 Eagle 导入" })).toBeNull());
    rerender(bar({ report }));

    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
  });

  it("开始导入后对话框连同遮罩一起关闭，窗口仍可点按（#98 本机 r12）", async () => {
    backend();
    render(bar({ report: null }));
    await fromEagle();
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
    fireEvent.click(within(plan).getByRole("button", { name: "开始导入" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "从 Eagle 导入" })).toBeNull());
    // 留下的遮罩会盖住整个窗口、吃掉所有点按。
    await waitFor(() => expect(document.querySelector(".k-backdrop")).toBeNull());
  });

  it("普通导入完成后不显示这一步", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    rerender(bar({ report }));
    await screen.findByRole("region", { name: "导入结果" });
    expect(screen.queryByRole("region", { name: "标签的外部对应" })).toBeNull();
  });
});


describe("封印重复项回执", () => {
  it("默认只提示存在封印重复项，不显示成功项数量或内容", async () => {
    backend();
    render(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
    expect(await screen.findByText("有封印项重复，是否展开看看")).toBeTruthy();
    expect(screen.queryByText(/新增.*张/)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "展开本次重复项" })).toBeTruthy();
  });
});


it("关闭期间迟到的预览字节不会创建图片，且回执仍需重新明确展开", async () => {
  mockWindows("main");
  const calls: string[] = [];
  let release!: () => void, channel: Channel<ArrayBuffer> | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  mockIPC((cmd, args) => {
    calls.push(cmd);
    if (cmd === "plugin:library|open_import_preview") return { id: "receipt-session", items: ["opaque-item"] };
    if (cmd === "plugin:library|read_import_preview") { channel = (args as { onChunk: Channel<ArrayBuffer> }).onChunk; return pending; }
    return undefined;
  }, { shouldMockEvents: true });
  const create = vi.fn(() => "blob:preview");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
  const { rerender } = render(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  fireEvent.click(screen.getByRole("button", { name: "展开本次重复项" }));
  await waitFor(() => expect(calls).toContain("plugin:library|read_import_preview"));
  fireEvent.click(screen.getByRole("button", { name: "关闭重复项预览" }));
  await waitFor(() => expect(calls).toContain("plugin:library|close_import_preview"));
  channel!.onmessage(new Uint8Array([137,80,78,71]).buffer);
  channel!.onmessage(new ArrayBuffer(0));
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  vi.unstubAllGlobals();
});


it("展开后是界面系统的对话框：标题与说明用规格原话，关闭按钮可用", async () => {
  mockWindows("main");
  mockIPC((cmd) => {
    if (cmd === "plugin:library|open_import_preview") return { id: "session", items: [] };
    return undefined;
  }, { shouldMockEvents: true });
  render(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  fireEvent.click(screen.getByRole("button", { name: "展开本次重复项" }));
  const dialog = await screen.findByRole("dialog", { name: "本次封印重复项" });
  expect(dialog.className).toContain("k-dialog");
  expect(dialog.tagName).not.toBe("DIALOG");
  expect(dialog.textContent).toContain("只展开本次重复项");
  expect(dialog.textContent).toContain("关闭后重新遮蔽");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭重复项预览" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "本次封印重复项" })).toBeNull());
});

it("切换到另一张回执不会自动沿用前一张回执的明确同意", async () => {
  mockWindows("main");
  const opened: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|open_import_preview") { opened.push((args as { taskId: string }).taskId); return { id: "session", items: [] }; }
    return undefined;
  }, { shouldMockEvents: true });
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
  const receiptBar = (taskId: string) => <ImportBar enabled libraryId="L1" libraryName="参考" running={null} finished={{ taskId, report: { ...report, sealedDuplicates: true, privateSummary: true } }} onStarted={() => {}} onDismissReport={() => {}} />;
  const { rerender } = render(receiptBar("task-first"));
  fireEvent.click(screen.getByRole("button", { name: "展开本次重复项" }));
  await waitFor(() => expect(opened).toEqual(["task-first"]));
  rerender(receiptBar("task-next"));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(opened).toEqual(["task-first"]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

describe("导入对话框与右下角卡片（#98）", () => {
  it("Eagle 的删过的图默认继续跳过，选“这次也导入”只对这次任务生效", async () => {
    const started: unknown[] = [];
    mockWindows("main");
    mockIPC((cmd, args) => {
      if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
      if (cmd === "plugin:library|discover_eagle_libraries") return [{ name: "主库", path: "D:/Eagle/主库.library", items: 3, version: "4.0.0", foundBy: "settings" }];
      if (cmd === "plugin:library|start_import") { started.push(args); return "task-1"; }
      return undefined;
    }, { shouldMockEvents: true });
    render(bar({ report: null }));
    await fromEagle();
    fireEvent.click(await screen.findByRole("button", { name: "导入 主库" }));
    const plan = await screen.findByRole("dialog", { name: "从 Eagle 导入" });
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

  it("进度卡显示保存位置与进度，可以后台进行，再从导入菜单找回", async () => {
    backend();
    const actions = { current: null as null | { showTasks: () => void } };
    const view = () => <ImportBar enabled libraryId="L1" libraryName="参考" ownerLabel="参考 / 人物"
      running={{ taskId: "task-1", progress: { done: 12, total: 38 } }} finished={null} onStarted={() => {}} onDismissReport={() => {}}
      actionsRef={actions as never} />;
    const { rerender } = render(view());
    const card = await screen.findByRole("region", { name: "导入进度" });
    expect(within(card).getByText("放到 参考 / 人物")).toBeTruthy();
    expect(within(card).getByText("12 / 38")).toBeTruthy();
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("12");
    expect(within(card).getByRole("button", { name: "取消导入" }).textContent).toBe("取消");
    fireEvent.click(within(card).getByRole("button", { name: "后台进行" }));
    expect(screen.queryByRole("region", { name: "导入进度" })).toBeNull();
    rerender(view());
    expect(screen.queryByRole("region", { name: "导入进度" })).toBeNull();
    await act(async () => actions.current!.showTasks());
    expect(screen.getByRole("region", { name: "导入进度" })).toBeTruthy();
  });

  it("结果卡列出新增、已存在与失败，重试只针对读取失败的项", async () => {
    backend();
    const finished = { taskId: "task-1", report: { ...report, items: [
      { path: "a.png", outcome: { kind: "imported", imageId: "a" } }, { path: "b.png", outcome: { kind: "merged", imageId: "b" } },
      { path: "c.txt", outcome: { kind: "unsupported" } }, { path: "d.png", outcome: { kind: "readFailed", reason: "被占用" } },
    ] } } as never;
    render(<ImportBar enabled libraryId="L1" libraryName="参考" running={null} finished={finished} onStarted={() => {}} onDismissReport={() => {}} />);
    const card = await screen.findByRole("region", { name: "导入结果" });
    expect(card.textContent).toContain("新增 1");
    expect(card.textContent).toContain("已存在 1");
    expect(card.textContent).toContain("没导入 2");
    expect(within(card).getByText("读取失败：被占用")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "重试失败的 1 项" }).textContent).toBe("重试失败");
  });
});
