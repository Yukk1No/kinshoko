import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { TagGroupsPane } from "./TagGroupsPane";

afterEach(() => { cleanup(); clearMocks(); });

const tag = (id: string, name: string) => ({ id, namespace: "general" as const, name, untranslated: false, hasExternal: true });

// 给分组加标签（设计系统 Combobox）：已在分组里的标签不列，但不能占掉候选的名额；Esc 只收起输入框。
it("加标签时不列已有成员，仍列满其余匹配的标签；Esc 收起后焦点回到“加标签”", async () => {
  const members = ["猫耳", "猫尾"].map((name, i) => tag(`has-${i}`, name));
  const others = Array.from({ length: 9 }, (_, i) => tag(`t-${i}`, `猫${i}`));
  const limits: number[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("shared_tag_groups")) return [{ id: "G", name: "猫", namespace: null, tags: members.map((t) => ({ tag: t, count: 1 })), sources: [] }];
    if (cmd.endsWith("workspace_candidates")) {
      const { limit } = args as { limit: number };
      limits.push(limit);
      return [...members, ...others].slice(0, limit).map((t, i) => ({ tag: t, via: null, count: 20 - i }));
    }
    return null;
  });
  render(<TagGroupsPane safe={false} generation={0} onBrowse={() => {}} onError={() => {}} />);
  const add = await screen.findByRole("button", { name: "给“猫”加标签" });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  const input = screen.getByRole("combobox", { name: "挑一个统一标签" });
  input.focus();
  fireEvent.change(input, { target: { value: "猫" } });

  const list = await screen.findByRole("listbox", { name: "挑一个统一标签" });
  await within(list).findByRole("option", { name: /猫7/ });
  const names = within(list).getAllByRole("option").map((o) => o.textContent);
  expect(names.filter((n) => /猫耳|猫尾/.test(n ?? ""))).toEqual([]);
  expect(names.filter((n) => /^猫\d/.test(n ?? ""))).toHaveLength(8);
  expect(limits.at(-1)).toBe(10);

  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  input.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("给“猫”加标签"));
  expect(screen.queryByRole("combobox", { name: "挑一个统一标签" })).toBeNull();
});
