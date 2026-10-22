// 窄查找框（#222）：放不下的条件标签收进前面的“+n”，点开仍可读、可排除、可去掉；输入框留出最小宽度。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { SearchInput } from "../bindings/SearchInput";
import { SearchBox } from "./SearchBox";

const text = (t: string) => ({ any: [{ kind: "text" as const, text: t, dismissed: [] }], negate: false });
const three: SearchInput = { conditions: [text("天空"), text("云"), text("夕阳")], exact: false };

let searchWidth = 0;
beforeEach(() => {
  mockIPC(() => null);
  // jsdom 不排版：查找框宽 searchWidth，每个条件标签宽 100，精确查找开关宽 32。
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("search") ? searchWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("search-chip")) return 100;
    if (this.classList.contains("k-exact")) return 32;
    return 0;
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.restoreAllMocks(); });

const box = (input: SearchInput, onChange = vi.fn()) => {
  render(<SearchBox libraryId="L1" safe={false} generation={0} input={input} tree={null} showSource={false} onChange={onChange} onError={() => {}} />);
  return onChange;
};
const chips = () => within(screen.getByRole("list", { name: "查找条件" }));

it("宽查找框里条件全部显示，没有“+n”", () => {
  searchWidth = 900;
  box(three);
  expect(chips().getAllByRole("button", { name: "去掉这个条件" })).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /还有 \d+ 个条件/ })).toBeNull();
});

it("还没排版（宽度为 0）时不收起", () => {
  searchWidth = 0;
  box(three);
  expect(chips().getAllByRole("button", { name: "去掉这个条件" })).toHaveLength(3);
});

it("窄查找框只显示末尾放得下的条件，其余收进“+n”，点开可读可去掉", () => {
  // 300 − 开关 32 − 输入框最小宽度 = 留给标签的宽度；只放得下“+n”和最后一个。
  searchWidth = 300;
  const onChange = box(three);
  expect(chips().getAllByRole("button", { name: "去掉这个条件" })).toHaveLength(1);
  expect(chips().getByText("“夕阳”")).toBeTruthy();
  const more = screen.getByRole("button", { name: "还有 2 个条件" });
  expect(more.textContent).toBe("+2");

  fireEvent.click(more);
  const hidden = within(screen.getByRole("dialog", { name: "收起的查找条件" }));
  expect(hidden.getByText("“天空”")).toBeTruthy();
  expect(hidden.getByText("“云”")).toBeTruthy();
  fireEvent.click(hidden.getAllByRole("button", { name: "去掉这个条件" })[0]);
  expect(onChange).toHaveBeenLastCalledWith({ conditions: [text("云"), text("夕阳")], exact: false });
});

it("收起的条件也能排除", () => {
  searchWidth = 300;
  const onChange = box(three);
  fireEvent.click(screen.getByRole("button", { name: "还有 2 个条件" }));
  const hidden = within(screen.getByRole("dialog", { name: "收起的查找条件" }));
  fireEvent.click(hidden.getAllByRole("button", { name: "排除这个条件" })[1]);
  expect(onChange).toHaveBeenLastCalledWith({ conditions: [text("天空"), { ...text("云"), negate: true }, text("夕阳")], exact: false });
});
