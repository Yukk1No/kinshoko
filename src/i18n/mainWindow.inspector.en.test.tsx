import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { i18n } from ".";
import { SelectionBar } from "../library/SelectionBar";
import { TagChip } from "../tags/TagChip";
import { DEFAULT_TAG_DISPLAY, originLine } from "../tags/tagConfidence";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下详情侧栏的选择操作与标签浮层没有中文界面文案（#356）。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  cleanup();
  await act(async () => {});
  clearMocks();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("英文界面：详情侧栏", () => {
  it("选择操作条", async () => {
    mockIPC((cmd) => (cmd === "plugin:library|workspace_sidebar" ? { all: 2, trash: 0, folders: [] } : undefined), { shouldMockEvents: true });
    render(<SelectionBar libraryId="L1" scope={{ kind: "folder", id: "f" }} ids={["a", "b"]} onClear={vi.fn()} reloadKey={0} onError={vi.fn()} left={0} onWidth={vi.fn()} />);
    expect(await screen.findByText("2 selected")).toBeTruthy();
    expectNoChinese(document.body);
  });

  it("标签出处：自动标签带可信度与档位，其余按来源", () => {
    const lines = [
      originLine({ kind: "source", source: "model:pixai", score: 0.9 }, DEFAULT_TAG_DISPLAY),
      originLine({ kind: "manual" }, DEFAULT_TAG_DISPLAY),
      originLine({ kind: "source", source: "eagle:x", score: null }, DEFAULT_TAG_DISPLAY),
    ];
    expect(lines).toEqual(["Auto tag, confidence 90% (high)", "Source: added by you", "Source: imported from Eagle"]);
  });

  it("标签浮层：命名空间与未翻译提示", async () => {
    render(<ul><TagChip tag={{ id: "t", name: "blue eyes", namespace: "character", untranslated: true, hasExternal: false }}
      origins={[{ kind: "source", source: "model:pixai", score: 0.5 }]} meter actions={null} /></ul>);
    fireEvent.focus(screen.getByRole("listitem"));
    expect(await screen.findByText("No English name yet; showing the original name")).toBeTruthy();
    expect(screen.getByText("Character: blue eyes")).toBeTruthy();
    expectNoChinese(document.body);
  });
});
