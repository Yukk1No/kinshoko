// 搜索框候选里的未翻译标记（#160）：翻译图标，悬停提示“未翻译”（设计系统 Combobox）；不再写“文A”。
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SearchBox } from "./SearchBox";

afterEach(() => { cleanup(); clearMocks(); });

it("未翻译的候选标签名后面是翻译图标，没有“文A”", async () => {
  mockIPC((cmd) => {
    if (cmd === "plugin:library|search_candidates") return [
      { tag: { id: "t1", namespace: "general", name: "ahoge", untranslated: true, hasExternal: true }, count: 3, via: null },
      { tag: { id: "t2", namespace: "general", name: "阿呆毛", untranslated: false, hasExternal: true }, count: 1, via: null },
    ];
    if (cmd === "plugin:library|rating_candidates") return [];
    return null;
  });
  render(<SearchBox libraryId="L1" safe={false} generation={0} input={{ conditions: [], exact: false }} tree={null} showSource={false}
    onChange={() => {}} onError={() => {}} />);
  fireEvent.change(screen.getByRole("combobox", { name: "查找参考图" }), { target: { value: "a" } });
  const raw = await screen.findByRole("option", { name: /ahoge/ });
  expect(within(raw).getByRole("img", { name: "未翻译" }).getAttribute("title")).toBe("未翻译");
  const named = screen.getByRole("option", { name: /阿呆毛/ });
  expect(within(named).queryByRole("img", { name: "未翻译" })).toBeNull();
  expect(screen.getByRole("listbox").textContent).not.toContain("文A");
});
