import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagGroupPicker } from "./TagGroupPicker";
import { fakeBackend, type FakeBackend } from "../test/backend";

const tag = (id: string, name: string) => ({
  tag: { id, name, namespace: "general", untranslated: false, hasExternal: false },
  count: 1,
});
const hair = { id: "hair", name: "发色", namespace: null, tags: [tag("blue", "蓝发")] };
const eyes = { id: "eyes", name: "瞳色", namespace: null, tags: [tag("red", "红瞳"), tag("green", "绿瞳")] };
let groups = [hair, eyes];

const bar = (over: Partial<Parameters<typeof TagGroupPicker>[0]> = {}) => (
  <TagGroupPicker
    libraryId="lib"
    safe={false}
    generation={0}
    input={{ conditions: [], exact: false }}
    onChange={vi.fn()}
    onError={vi.fn()}
    {...over}
  />
);
const button = (name: RegExp) => screen.findByRole("button", { name });
const popup = () => screen.queryByRole("dialog");
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let backend: FakeBackend;

beforeEach(() => {
  groups = [hair, eyes];
  backend = fakeBackend({ tag_groups: () => groups });
});

const open = async () => {
  const btn = await button(/^标签分组$/);
  fireEvent.click(btn);
  await settle();
  return btn;
};

describe("标签分组面板（#607）", () => {
  it("点图标展开，所有分组的标签一次摆出来；再点收回", async () => {
    render(bar());
    const btn = await button(/^标签分组$/);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(popup()?.getAttribute("aria-label")).toBe("标签分组");
    expect(await screen.findByRole("button", { name: /蓝发/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /红瞳/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "发色标签" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "瞳色标签" })).toBeTruthy();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("Esc 只关面板，焦点回到按钮，不传到文档上关掉浮动侧栏", async () => {
    const pane = vi.fn();
    render(bar());
    const btn = await open();
    expect(popup()?.contains(document.activeElement)).toBe(true);
    document.addEventListener("keydown", pane);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(popup()).toBeNull());
    document.removeEventListener("keydown", pane);
    expect(pane).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btn);
  });

  it("点面板外关闭", async () => {
    render(bar());
    await open();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("跨分组连选：选标签、选“任一”后面板都不关", async () => {
    const change = vi.fn();
    render(bar({ onChange: change }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: /蓝发/ }));
    fireEvent.click(screen.getByRole("button", { name: /红瞳/ }));
    fireEvent.click(screen.getByRole("button", { name: "按“瞳色”任一标签查找" }));
    expect(change).toHaveBeenCalledTimes(3);
    await settle();
    expect(popup()).toBeTruthy();
  });

  it("右键排除，Ctrl 单击加进上一个条件", async () => {
    const change = vi.fn();
    const blue = { kind: "tag" as const, id: "blue", dismissed: [] };
    const red = { kind: "tag" as const, id: "red", dismissed: [] };
    render(bar({ onChange: change, input: { conditions: [{ any: [blue], negate: false }], exact: false } }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: /红瞳/ }), { ctrlKey: true });
    expect(change).toHaveBeenLastCalledWith({ conditions: [{ any: [blue, red], negate: false }], exact: false });
    fireEvent.contextMenu(screen.getByRole("button", { name: /红瞳/ }));
    expect(change).toHaveBeenLastCalledWith({
      conditions: [
        { any: [blue], negate: false },
        { any: [red], negate: true },
      ],
      exact: false,
    });
  });

  it("“任一成员”再点一次是取消，不叠一条一样的条件", async () => {
    const change = vi.fn();
    const red = { kind: "tag" as const, id: "red", dismissed: [] };
    const green = { kind: "tag" as const, id: "green", dismissed: [] };
    const blue = {
      conditions: [{ any: [{ kind: "tag" as const, id: "blue", dismissed: [] }], negate: false }],
      exact: false,
    };
    const view = render(bar({ onChange: change, input: blue }));
    await open();
    const any = screen.getByRole("button", { name: "按“瞳色”任一标签查找" });
    expect(any.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(any);
    expect(change).toHaveBeenLastCalledWith({
      ...blue,
      conditions: [...blue.conditions, { any: [red, green], negate: false }],
    });
    const on = { ...blue, conditions: [...blue.conditions, { any: [green, red], negate: false }] };
    view.rerender(bar({ onChange: change, input: on }));
    const pressed = screen.getByRole("button", { name: "按“瞳色”任一标签查找" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(change).toHaveBeenLastCalledWith(blue);
  });

  it("条件里重复的同一标签不算整组都选了", async () => {
    const red = { kind: "tag" as const, id: "red", dismissed: [] };
    render(bar({ input: { conditions: [{ any: [red, red], negate: false }], exact: false } }));
    await open();
    expect(screen.getByRole("button", { name: "按“瞳色”任一标签查找" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("“编辑分组”在面板底部，点了打开编辑器并收起面板", async () => {
    const edit = vi.fn();
    render(bar({ onEdit: edit }));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "编辑分组" }));
    expect(edit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("没有分组时面板里写“还没有分组”", async () => {
    groups = [];
    render(bar());
    await open();
    expect(screen.getByText("还没有分组")).toBeTruthy();
  });

  it("词表刷新时面板留着并显示新数据", async () => {
    const view = render(bar());
    await open();
    groups = [{ ...hair, tags: [tag("blue", "蓝发"), tag("pink", "粉发")] }, eyes];
    view.rerender(bar({ generation: 1 }));
    expect(popup()).toBeTruthy();
    expect(await screen.findByRole("button", { name: /粉发/ })).toBeTruthy();
  });

  it("安全模式切换立刻收掉面板，不留旧视角的标签", async () => {
    const view = render(bar());
    await open();
    expect(screen.getByRole("button", { name: /蓝发/ })).toBeTruthy();
    view.rerender(bar({ safe: true }));
    expect(screen.queryByRole("button", { name: /蓝发/ })).toBeNull();
    expect(popup()).toBeNull();
  });

  it("workspace_tag_groups 遇到游标过期时重试，成功后显示分组", async () => {
    let calls = 0;
    backend.on("workspace_tag_groups", () => {
      calls++;
      if (calls === 1) return Promise.reject({ code: "cursorExpired" });
      return groups;
    });
    render(bar({ workspace: true }));

    await waitFor(() => expect(calls).toBe(2));
    await open();
    expect(await screen.findByRole("button", { name: /蓝发/ })).toBeTruthy();
  });

  it("词表重读时先发的旧分组响应迟到，不覆盖新分组", async () => {
    const pending: Array<(value: unknown) => void> = [];
    backend.on(
      "workspace_tag_groups",
      () =>
        new Promise<unknown>((resolve) => {
          pending.push(resolve);
        }),
    );
    const view = render(bar({ workspace: true, generation: 0 }));
    await waitFor(() => expect(pending).toHaveLength(1));

    view.rerender(bar({ workspace: true, generation: 1 }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]([eyes]));
    await act(async () => pending[0]([hair]));

    await open();
    expect(await screen.findByRole("button", { name: /红瞳/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /蓝发/ })).toBeNull();
  });
});
