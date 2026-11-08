import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { parseTyped, TagPanel } from "./TagPanel";

afterEach(() => { cleanup(); clearMocks(); });

const tag = (id: string, name: string) => ({ id, namespace: "general", name, untranslated: false, hasExternal: true });

// 添加标签的候选（设计系统 Combobox）：已经有的标签不列，但不能占掉候选的名额。
it("已经有的标签排在前面时，仍列满其余匹配的标签", async () => {
  const assigned = ["猫耳", "猫尾"].map((name, i) => tag(`has-${i}`, name));
  const others = Array.from({ length: 9 }, (_, i) => tag(`t-${i}`, `猫${i}`));
  const limits: number[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("catalog_image_tags")) return { image: { imageId: "a", rejected: [], tags: assigned.map((t) => ({ tag: t, origins: [{ kind: "manual" }] })) }, identities: [] };
    if (cmd.endsWith("workspace_library_candidates")) {
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

// 添加标签只有一个输入框（设计系统 Combobox）：不另放按钮行；排除在候选行尾，类别在新建项上选或写在名称前。
describe("添加标签的输入框", () => {
  const setup = (ids: string[]) => {
    const edits: unknown[] = [];
    const limits: number[] = [];
    mockIPC((cmd, args) => {
      if (cmd.endsWith("catalog_image_tags")) return { image: { imageId: "a", rejected: [], tags: [] }, identities: [] };
      if (cmd.endsWith("workspace_library_candidates")) {
        const { text, limit } = args as { text: string; limit: number };
        limits.push(limit);
        return [tag("t-cat", "猫"), { ...tag("t-artist", "某某"), namespace: "artist" }].filter((t) => t.name.includes(text.trim())).map((t) => ({ tag: t, via: null, count: 3 }));
      }
      if (cmd.endsWith("edit_tags")) { edits.push((args as { edits: unknown[] }).edits[0]); return null; }
      return null;
    });
    render(<TagPanel libraryId="L1" ids={ids} safe={false} generation={0} onError={() => {}} />);
    const input = screen.getByRole("combobox", { name: "标签名" });
    const type = async (value: string) => {
      input.focus();
      fireEvent.change(input, { target: { value } });
      return screen.findByRole("listbox", { name: "标签名" });
    };
    return { edits, limits, input, type };
  };

  it("候选行尾的“排除”否决这个标签，Alt+回车同样排除；不再有按钮行与说明句", async () => {
    const { edits, input, type } = setup(["a"]);
    const list = await type("猫");
    fireEvent.click(await within(list).findByRole("button", { name: "否决“猫”" }));
    await waitFor(() => expect(edits).toEqual([{ kind: "reject", tag: { kind: "id", id: "t-cat" } }]));
    expect(within(list).queryByRole("button", { name: "清除对“猫”的人工决定" })).toBeNull();

    await within(await type("猫")).findByRole("option", { name: /猫/ });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    await waitFor(() => expect(edits).toHaveLength(2));
    expect(edits[1]).toEqual({ kind: "reject", tag: { kind: "id", id: "t-cat" } });
    expect(screen.queryByRole("button", { name: "添加标签" })).toBeNull();
  });

  it("选了几张时候选行尾还有“改回自动”", async () => {
    const { edits, type } = setup(["a", "b"]);
    const list = await type("猫");
    fireEvent.click(await within(list).findByRole("button", { name: "清除对“猫”的人工决定" }));
    await waitFor(() => expect(edits).toEqual([{ kind: "clear", tag: { kind: "id", id: "t-cat" } }]));
    expect(screen.queryByText(/一起记下/)).toBeNull();
  });

  it("选了几张时新建项上也能按输入的名称改回自动（在所有图上都被排除的标签不在候选里）", async () => {
    const { edits, type } = setup(["a", "b"]);
    const list = await type("眼镜");
    const row = await within(list).findByRole("option", { name: /^新建“眼镜”/ });
    fireEvent.click(within(row).getByRole("button", { name: "清除对“眼镜”的人工决定" }));
    await waitFor(() => expect(edits).toEqual([{ kind: "clear", tag: { kind: "named", namespace: "general", name: "眼镜", lang: "zh-CN" } }]));
  });

  it("写了类别前缀时多取候选再按类别筛，不被别的类别挤掉", async () => {
    const { limits, type } = setup(["a"]);
    await within(await type("猫")).findByRole("option", { name: /猫/ });
    expect(limits.at(-1)).toBe(8);
    await within(await type("作者：某")).findByRole("option", { name: /某某/ });
    expect(limits.at(-1)).toBeGreaterThanOrEqual(500);
  });

  it("名称前写类别（作者：）就按这个类别新建，候选也只列这个类别；选过的类别只管一次", async () => {
    const { edits, type } = setup(["a"]);
    let list = await type("作者：新人");
    const row = await within(list).findByRole("option", { name: /^新建“新人”/ });
    expect(within(row).getByRole("radio", { checked: true }).textContent).toBe("作者");
    fireEvent.click(row);
    await waitFor(() => expect(edits).toEqual([{ kind: "add", tag: { kind: "named", namespace: "artist", name: "新人", lang: "zh-CN" } }]));

    // 写了“作者：某某”就是已有的作者标签，不给新建项；不写类别时一般的“某某”可以新建。
    list = await type("作者:某某");
    await within(list).findByRole("option", { name: /某某/ });
    expect(within(list).queryByRole("option", { name: /^新建/ })).toBeNull();
    list = await type("某某");
    const plain = await within(list).findByRole("option", { name: /^新建“某某”/ });
    expect(within(plain).getByRole("radio", { checked: true }).textContent).toBe("一般");
  });
});

it("parseTyped 认全角、半角冒号，不分大小写；不写类别时原样返回", () => {
  const prefix = (ns: string) => ({ general: "", artist: "作者：", character: "角色：", work: "作品：" })[ns]!;
  expect(parseTyped(" 角色：初音 ", prefix)).toEqual({ namespace: "character", name: "初音" });
  expect(parseTyped("作品:某作", prefix)).toEqual({ namespace: "work", name: "某作" });
  expect(parseTyped("作者", prefix)).toEqual({ namespace: null, name: "作者" });
  expect(parseTyped("artist: X", (ns) => (ns === "artist" ? "Artist: " : ""))).toEqual({ namespace: "artist", name: "X" });
});
