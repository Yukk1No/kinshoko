import { afterEach, describe, expect, it } from "vitest";
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

const report: ImportReport = { items: [], cancelled: false, eagleMissing: 0, eagleRelocations: [] };

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
  it("从 Eagle 迁入完成后进入“标签的外部对应”一步", async () => {
    backend();
    const { rerender } = render(bar({ report: null }));
    fireEvent.click(screen.getByRole("button", { name: "从 Eagle 迁入…" }));
    fireEvent.click(await screen.findByRole("button", { name: "迁入 主库" }));
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
