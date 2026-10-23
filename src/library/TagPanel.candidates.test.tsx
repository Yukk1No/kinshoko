import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { TagPanel } from "./TagPanel";

afterEach(() => { cleanup(); clearMocks(); });

const tag = (id: string, name: string) => ({ id, namespace: "general", name, untranslated: false, hasExternal: true });

// 添加标签的候选（设计系统 Combobox）：已经有的标签不列，但不能占掉候选的名额。
it("已经有的标签排在前面时，仍列满其余匹配的标签", async () => {
  const assigned = ["猫耳", "猫尾"].map((name, i) => tag(`has-${i}`, name));
  const others = Array.from({ length: 9 }, (_, i) => tag(`t-${i}`, `猫${i}`));
  const limits: number[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("catalog_image_tags")) return { image: { imageId: "a", rejected: [], tags: assigned.map((t) => ({ tag: t, origins: [{ kind: "manual" }] })) }, identities: [] };
    if (cmd.endsWith("search_candidates")) {
      const { limit } = args as { limit: number };
      limits.push(limit);
      return [...assigned, ...others].slice(0, limit).map((t, i) => ({ tag: t, via: null, count: 20 - i }));
    }
    return null;
  });
  render(<TagPanel libraryId="L1" ids={["a"]} safe={false} generation={0} onError={() => {}} />);
  await screen.findByRole("list", { name: "有效标签" });
  const input = screen.getByRole("combobox", { name: "标签名" });
  input.focus();
  fireEvent.change(input, { target: { value: "猫" } });

  const list = await screen.findByRole("listbox", { name: "标签名" });
  await within(list).findByRole("option", { name: /猫7/ });
  const names = within(list).getAllByRole("option").map((o) => o.textContent);
  expect(names.filter((n) => /猫耳|猫尾/.test(n ?? ""))).toEqual([]);
  expect(names.filter((n) => /^猫\d/.test(n ?? ""))).toHaveLength(8);
  expect(limits.at(-1)).toBe(10);
});
