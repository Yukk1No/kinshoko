import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createRef } from "react";
import { i18n } from ".";
import type { ImportReport } from "../bindings/ImportReport";
import { ImportBar, type ImportActions } from "../library/ImportBar";
import { importNotice } from "../library/ImportBarParts";
import { EagleTagStep } from "../library/EagleTagStep";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下导入（确认对话框、进度与结果、上次中断、Eagle 迁入与标签的外部对应）没有中文界面文案（#357）。
// 图库名、Eagle 库名、标签名与文件路径是画师的数据。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

const data = ["参考", "主库", "蓝瞳", "水色", "D:/图/坏.png", "D:/图/新.png", "D:/图/半张.png"];
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

const report: ImportReport = {
  items: [
    { path: "D:/图/新.png", outcome: { kind: "imported", imageId: "i1" } },
    { path: "D:/图/坏.png", outcome: { kind: "unsupported" } },
    { path: "D:/图/旧.png", outcome: { kind: "skippedDeleted" } },
  ],
  cancelled: false, fromEagle: false, eagleMissing: 2,
  eagleRelocations: [{ sourceId: "s1", from: "D:/Eagle/old.library", to: "E:/Eagle/new.library", overlapPercent: 80 }],
  sealedDuplicates: false, privateSummary: false, trashDuplicates: true,
};

function backend() {
  mockWindows("main");
  mockIPC((cmd) => {
    if (cmd === "plugin:library|recovery") return { interrupted: ["D:/图/半张.png"], orphans: ["x"] };
    if (cmd === "plugin:library|discover_eagle_libraries")
      return [{ name: "主库", path: "D:/Eagle/main.library", items: 3, version: "4.0.0", foundBy: "settings" }];
    if (cmd === "plugin:library|eagle_tag_mapping") return {
      matched: [{ tag: { id: "t1", namespace: "general", name: "蓝瞳", untranslated: false, hasExternal: true }, count: 5, external: ["blue_eyes"], basis: "name", mergedInto: null }],
      unmatched: [{ tag: { id: "t2", namespace: "general", name: "水色", untranslated: false, hasExternal: false }, count: 3, candidates: ["aqua", "aqua_eyes"] }],
      vocabularySize: 0,
    };
    return undefined;
  }, { shouldMockEvents: true });
}

const actions = createRef<ImportActions>() as { current: ImportActions | null };
const bar = (finished: ImportReport | null) =>
  <ImportBar actionsRef={actions} enabled libraryId="L1" libraryName="参考" running={null}
    finished={finished && { taskId: "task-1", report: finished, libraryName: "参考", folderName: null } as never}
    onStarted={() => {}} onDismissReport={() => {}} />;

describe("英文界面：导入", () => {
  it("结果卡片、上次中断与 Eagle 库换了位置", async () => {
    backend();
    render(bar(report));
    await settle();
    expect(screen.getByRole("region", { name: "Import result" })).toBeTruthy();
    expect(screen.getByText("Into 参考 / Unsorted")).toBeTruthy();
    expect(screen.getByRole("alert", { name: "Did the Eagle library move?" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Last import was interrupted" })).toBeTruthy();
    fireEvent.click(screen.getByText("Files not imported"));
    expectNoChinese(document.body, data);
  });

  it("从 Eagle 导入：找到的库与确认对话框", async () => {
    backend();
    render(bar(null));
    await settle();
    act(() => { actions.current!.eagle(); });
    const found = await screen.findByRole("dialog", { name: "Import from Eagle" });
    expect(within(found).getByText("3 images")).toBeTruthy();
    expectNoChinese(document.body, data);
    fireEvent.click(within(found).getByRole("button", { name: "Import 主库" }));
    expect(await screen.findByRole("radio", { name: /Keep skipping/ })).toBeTruthy();
    expectNoChinese(document.body, data);
  });

  it("导入结束的轻提示", () => {
    const notice = importNotice(report, "参考 / Unsorted").toast(() => {});
    expect(notice.title).toBe("Import complete");
    render(<>{notice.description}</>);
    expectNoChinese(document.body, data);
    expect(notice.action?.label).toBe("View");
  });

  it("标签的外部对应", async () => {
    backend();
    render(<EagleTagStep libraryId="L1" onClose={() => {}} />);
    expect(await screen.findByRole("list", { name: "Tags without an external mapping" })).toBeTruthy();
    expect(screen.getByText(/1 matched automatically, 1 unmatched/)).toBeTruthy();
    expectNoChinese(document.body, data);
  });
});
