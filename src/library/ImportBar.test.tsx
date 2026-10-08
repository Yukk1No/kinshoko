import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ImportReport } from "../bindings/ImportReport";
import { ImportBar } from "./ImportBar";

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

function bar(props: { report: ImportReport | null }) {
  // 测试里启动命令总是返回 task-1，结束的也是它。
  const finished = props.report && { taskId: "task-1", report: props.report };
  return (
    <ImportBar
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
    fireEvent.click(screen.getByRole("button", { name: "从 Eagle 迁入…" }));
    fireEvent.click(await screen.findByRole("button", { name: "迁入 主库" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始 Eagle 导入" }));
    // 迁入开始后选择资料库的面板收起。
    await waitFor(() => expect(screen.queryByRole("region", { name: "Eagle 首次迁入" })).toBeNull());
    rerender(bar({ report }));

    expect(await screen.findByRole("region", { name: "标签的外部对应" })).toBeTruthy();
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
  let release!: (bytes: number[]) => void;
  const pending = new Promise<number[]>(resolve => { release = resolve; });
  mockIPC(cmd => {
    calls.push(cmd);
    if (cmd === "plugin:library|open_import_preview") return { id: "receipt-session", items: ["opaque-item"] };
    if (cmd === "plugin:library|read_import_preview") return pending;
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
  release([137,80,78,71]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(bar({ report: { ...report, sealedDuplicates: true, privateSummary: true } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  vi.unstubAllGlobals();
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
