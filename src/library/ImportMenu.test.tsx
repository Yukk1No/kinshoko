import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Channel } from "@tauri-apps/api/core";
import type { ImportTaskSnapshot } from "../bindings/ImportTaskSnapshot";
import { ImportMenu } from "./ImportMenu";

afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); clearMocks(); vi.unstubAllGlobals(); });

const receipt: ImportTaskSnapshot = {
  taskId: "actual-task", destination: { libraryId: "L1", folderId: null }, libraryName: "参考", folderName: "未归类",
  progress: { done: 3, total: 3 }, finishing: false, warnings: [],
  report: { cancelled: false, fromEagle: false, eagleMissing: 0, eagleRelocations: [], sealedDuplicates: false, privateSummary: false, trashDuplicates: false,
    items: [ { path: "sealed-name.png", outcome: { kind: "merged", imageId: "sealed-id" } }, { path: "visible-name.png", outcome: { kind: "refreshed", imageId: "visible-id" } }, { path: "missing.png", outcome: { kind: "readFailed", reason: "missing" } } ] },
};

function menu() { return <ImportMenu enabled libraryId="L1" libraryName="参考" running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />; }

describe("导入回执上下文撤销", () => {
  for (const [event, payload] of [["safe-mode-setting", true], ["workspace-changed", { revision: "after", libraries: [] }]] as const) {
    it(`${event} 隐去旧成功统计，并拒绝迟到的旧快照`, async () => {
      mockWindows("main");
      let calls = 0, release!: (value: ImportTaskSnapshot[]) => void;
      const pending = new Promise<ImportTaskSnapshot[]>(resolve => { release = resolve; });
      mockIPC(cmd => {
        if (cmd === "plugin:library|import_tasks") { calls++; return calls === 1 ? [receipt] : pending; }
        if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
        return undefined;
      }, { shouldMockEvents: true });
      render(menu());
      const region = await screen.findByRole("region", { name: "导入结果" });
      expect(region.textContent).toContain("合并 1");
      await waitFor(() => expect(calls).toBe(2));
      await act(() => emit(event, payload));
      expect(region.textContent).not.toMatch(/新增|合并|更新 Eagle/);
      expect(region.textContent).toContain("missing.png");
      await act(async () => { release([receipt]); await pending; });
      expect(region.textContent).not.toMatch(/新增|合并|更新 Eagle/);
      expect(region.textContent).not.toContain("sealed-name");
      expect(region.textContent).toContain("missing.png");
    });
  }
});


for (const phase of ["已显示图片", "读取尚未完成"] as const) it(`当前资料库改变立即遮蔽${phase}，保留实际任务回执并要求再次同意`, async () => {
  mockWindows("main");
  const closed: string[] = [];
  let channel: Channel<ArrayBuffer> | undefined, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const sealed = { ...receipt, progress: { done: 0, total: 0 }, report: { ...receipt.report!, items: [], sealedDuplicates: true, privateSummary: true } };
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|import_tasks") return [sealed];
    if (cmd === "plugin:library|library_recovery") return { interrupted: [], orphans: [] };
    if (cmd === "plugin:library|open_import_preview") return { id: "actual-receipt-session", items: ["opaque-item"] };
    if (cmd === "plugin:library|read_import_preview") {
      channel = (args as { onChunk: Channel<ArrayBuffer> }).onChunk;
      if (phase === "读取尚未完成") return pending;
      channel.onmessage(new Uint8Array([137, 80, 78, 71]).buffer);
      channel.onmessage(new ArrayBuffer(0));
    }
    if (cmd === "plugin:library|close_import_preview") closed.push((args as { sessionId: string }).sessionId);
    return undefined;
  }, { shouldMockEvents: true });
  const revoke = vi.fn(), create = vi.fn(() => "blob:actual-receipt-preview");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
  const current = (libraryId: string) => <ImportMenu enabled libraryId={libraryId} libraryName="当前资料库" running={null} finished={null} onStarted={() => {}} onDismissReport={() => {}} />;
  const { rerender } = render(current("L1"));
  fireEvent.click(await screen.findByRole("button", { name: "展开本次重复项" }));
  if (phase === "已显示图片") expect(await screen.findByRole("img", { name: "本次导入的重复项" })).toBeTruthy();
  else await waitFor(() => expect(channel).toBeDefined());
  rerender(current("L2"));
  expect(screen.queryByRole("dialog")).toBeNull();
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
  expect(screen.getByText("任务保存位置：参考 / 未归类")).toBeTruthy();
  expect(screen.getByRole("button", { name: "展开本次重复项" })).toBeTruthy();
  rerender(current("L1"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
});
