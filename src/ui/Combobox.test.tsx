import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Combobox, Highlight, type ComboboxOption } from "./Combobox";

afterEach(cleanup);

const TAGS = [
  { id: "cat", name: "猫耳", count: 128 },
  { id: "neko", name: "猫", via: "neko", count: 40, untranslated: true },
  { id: "cattail", name: "猫尾", count: 3 },
];

type Picked = { id: string; alt: boolean };

function TagAdder({ added = [], onBackspace, autoHighlight }: { added?: string[]; onBackspace?: () => void; autoHighlight?: boolean }) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const query = text.trim();
  const found = query ? TAGS.filter((t) => !added.includes(t.id) && (t.name.includes(query) || t.via?.includes(query))) : [];
  const options: ComboboxOption[] = query ? [
    ...found.map((t) => ({ id: t.id, label: <Highlight text={t.name} query={query} />, via: t.via && <>别名 <Highlight text={t.via} query={query} /></>, untranslated: t.untranslated, meta: t.count })),
    { id: "create", create: true, label: `新建标签“${query}”` },
  ] : [];
  return <>
    <Combobox label="标签名" placeholder="加标签" value={text} onValueChange={setText} options={options} autoHighlight={autoHighlight}
      empty={query && found.length === 0 ? "没有匹配的标签" : undefined}
      onSelect={(option, event) => { setPicked((p) => [...p, { id: option.id, alt: event.altKey }]); setText(""); }}
      onBackspaceEmpty={onBackspace} />
    <output aria-label="已选">{picked.map((p) => p.id + (p.alt ? "+alt" : "")).join(",")}</output>
  </>;
}

const input = () => screen.getByRole("combobox", { name: "标签名" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(input(), { key: k, ...init });
const highlighted = () => document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
const picked = () => screen.getByRole("status", { name: "已选" }).textContent;

async function typeAndOpen(text: string) {
  input().focus();
  type(text);
  await act(async () => {});
  return screen.getByRole("listbox");
}

describe("Combobox", () => {
  it("是 TextField 外观的输入框，带 combobox 语义，收起时没有列表", () => {
    render(<TagAdder />);
    expect(input().closest(".k-combo")).toBeTruthy();
    expect(input().closest(".k-input")).toBeTruthy();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("输入后展开候选：默认高亮第一项，aria-activedescendant 指向它", async () => {
    render(<TagAdder />);
    const list = await typeAndOpen("猫");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    expect(list.className).toContain("k-listbox");
    expect(list.closest(".k-popup")).toBeTruthy();
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(4);
    expect(highlighted()).toBe(options[0]);
    expect(options[0].hasAttribute("data-highlighted")).toBe(true);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("↑↓ 移动高亮并循环，Enter 选中高亮项", async () => {
    render(<TagAdder />);
    await typeAndOpen("猫");
    key("ArrowDown");
    expect(highlighted()?.textContent).toContain("猫别名 neko");
    key("ArrowDown");
    key("ArrowDown");
    expect(highlighted()?.textContent).toBe("新建标签“猫”");
    key("ArrowDown");
    expect(highlighted()?.textContent).toContain("猫耳");
    key("ArrowUp");
    expect(highlighted()?.textContent).toBe("新建标签“猫”");
    key("ArrowUp");
    key("Enter", { altKey: true });
    expect(picked()).toBe("cattail+alt");
  });

  it("鼠标悬停移动高亮，单击选中且不让输入框失焦", async () => {
    render(<TagAdder />);
    const list = await typeAndOpen("猫");
    const third = within(list).getAllByRole("option")[2];
    fireEvent.mouseMove(third);
    expect(highlighted()).toBe(third);
    expect(fireEvent.mouseDown(third)).toBe(false);
    fireEvent.click(third);
    expect(picked()).toBe("cattail");
    expect(document.activeElement).toBe(input());
  });

  it("Esc 收起，再按 ↓ 重新展开；失焦收起", async () => {
    render(<TagAdder />);
    await typeAndOpen("猫");
    key("Escape");
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    key("ArrowDown");
    await act(async () => {});
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.blur(input());
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Tab 离开并收起，不拦截 Tab", async () => {
    render(<TagAdder />);
    await typeAndOpen("猫");
    expect(key("Tab")).toBe(true);
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("候选行：匹配的字用 mark，别名行、未翻译图标、张数靠右，新建项前有分隔线", async () => {
    render(<TagAdder />);
    const list = await typeAndOpen("ne");
    const [neko, create] = within(list).getAllByRole("option");
    expect(neko.querySelector(".k-option-via mark")?.textContent).toBe("ne");
    expect(neko.querySelector(".k-option-flag")?.getAttribute("title")).toBe("未翻译");
    expect(neko.querySelector(".k-item-meta")?.textContent).toBe("40");
    expect(create.className).toContain("is-create");
    expect(create.previousElementSibling?.className).toContain("k-sep");
    expect(create.querySelector(".k-item-ind svg")).toBeTruthy();

    type("猫耳");
    await act(async () => {});
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[0].querySelector("mark")?.textContent).toBe("猫耳");
  });

  it("没有匹配时先写“没有匹配的标签”，新建项照常给出并被高亮", async () => {
    render(<TagAdder />);
    const list = await typeAndOpen("狗");
    expect(list.querySelector(".k-option-empty")?.textContent).toBe("没有匹配的标签");
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["新建标签“狗”"]);
    key("Enter");
    expect(picked()).toBe("create");
  });

  it("已添加的标签不出现在候选里", async () => {
    render(<TagAdder added={["cat"]} />);
    const list = await typeAndOpen("猫");
    expect(within(list).queryByRole("option", { name: /猫耳/ })).toBeNull();
  });

  it("在空框里退格回调，有字时不回调", async () => {
    let backs = 0;
    render(<TagAdder onBackspace={() => backs++} />);
    input().focus();
    key("Backspace");
    expect(backs).toBe(1);
    type("猫");
    key("Backspace");
    expect(backs).toBe(1);
  });

  it("改了字高亮回到第一项，即使候选没变", async () => {
    function Fixed() {
      const [text, setText] = useState("");
      const options = [{ id: "text", label: `查找“${text}”` }, { id: "a", label: "猫耳" }, { id: "b", label: "猫尾" }];
      return <Combobox label="标签名" value={text} onValueChange={setText} options={options} onSelect={() => {}} />;
    }
    render(<Fixed />);
    await typeAndOpen("猫");
    key("ArrowDown");
    key("ArrowDown");
    expect(highlighted()?.textContent).toBe("猫尾");
    type("猫耳");
    await act(async () => {});
    expect(highlighted()?.textContent).toBe("查找“猫耳”");
  });

  it("autoHighlight 关闭时不预先高亮，Enter 不选候选、交给外层", async () => {
    render(<TagAdder autoHighlight={false} />);
    await typeAndOpen("猫");
    expect(highlighted()).toBeNull();
    key("Enter");
    expect(picked()).toBe("");
    key("ArrowDown");
    expect(highlighted()?.textContent).toContain("猫耳");
  });
});
