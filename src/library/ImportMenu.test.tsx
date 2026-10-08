import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ImportTaskSnapshot } from "../bindings/ImportTaskSnapshot";
import { ImportMenu } from "./ImportMenu";

afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); clearMocks(); });

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
