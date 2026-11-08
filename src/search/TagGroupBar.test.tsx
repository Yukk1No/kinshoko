import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagGroupBar } from "./TagGroupBar";

const tag = (id: string, name: string) => ({ tag: { id, name, namespace: "general", untranslated: false, hasExternal: false }, count: 1 });
const hair = { id: "hair", name: "发色", namespace: null, tags: [tag("blue", "蓝发")] };
const eyes = { id: "eyes", name: "瞳色", namespace: null, tags: [tag("red", "红瞳"), tag("green", "绿瞳")] };
let groups = [hair, eyes];

const bar = (over: Partial<Parameters<typeof TagGroupBar>[0]> = {}) =>
  <TagGroupBar libraryId="lib" safe={false} generation={0} input={{ conditions: [], exact: false }} onChange={vi.fn()} onError={vi.fn()} {...over} />;
const button = (name: RegExp) => screen.findByRole("button", { name });
const popup = () => screen.queryByRole("dialog");
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  groups = [hair, eyes];
  mockIPC((command) => command === "plugin:library|tag_groups" ? groups : null, { shouldMockEvents: true });
});
afterEach(() => { cleanup(); clearMocks(); });

describe("标签组下拉（#451）", () => {
  it("点按钮展开，再点收回", async () => {
    render(bar());
    const hairBtn = await button(/发色/);
    expect(hairBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(hairBtn);
    expect(hairBtn.getAttribute("aria-expanded")).toBe("true");
    expect(popup()?.getAttribute("aria-label")).toMatch(/发色/);
    expect(screen.getByRole("button", { name: /蓝发/ })).toBeTruthy();
    fireEvent.click(hairBtn);
    expect(hairBtn.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("开着时切组：同一个弹层换到新按钮，内容换成新组", async () => {
    render(bar());
    const hairBtn = await button(/发色/);
    const eyesBtn = await button(/瞳色/);
    fireEvent.click(hairBtn);
    const first = popup();
    fireEvent.click(eyesBtn);
    await settle();
    expect(popup()).toBe(first);
    expect(hairBtn.getAttribute("aria-expanded")).toBe("false");
    expect(eyesBtn.getAttribute("aria-expanded")).toBe("true");
    expect(first?.getAttribute("aria-label")).toMatch(/瞳色/);
    expect(screen.getByRole("button", { name: /红瞳/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /蓝发/ })).toBeNull());
  });

  it("Esc 关闭后焦点回到按钮，切组后回到新按钮", async () => {
    render(bar());
    const hairBtn = await button(/发色/);
    const eyesBtn = await button(/瞳色/);
    fireEvent.click(hairBtn);
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(popup()).toBeNull());
    expect(document.activeElement).toBe(hairBtn);
    fireEvent.click(hairBtn);
    fireEvent.click(eyesBtn);
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(popup()).toBeNull());
    expect(document.activeElement).toBe(eyesBtn);
  });

  it("Esc 只关弹层：不传到文档上关掉浮动侧栏", async () => {
    const pane = vi.fn();
    document.addEventListener("keydown", pane);
    render(bar());
    const hairBtn = await button(/发色/);
    fireEvent.click(hairBtn);
    await settle();
    expect(popup()?.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(popup()).toBeNull());
    document.removeEventListener("keydown", pane);
    expect(pane).not.toHaveBeenCalled();
  });

  it("点弹层外关闭", async () => {
    render(bar());
    fireEvent.click(await button(/发色/));
    await settle();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("选标签后弹层不关；选“任一”后关闭，焦点回到按钮", async () => {
    const change = vi.fn();
    render(bar({ onChange: change }));
    const hairBtn = await button(/发色/);
    fireEvent.click(hairBtn);
    fireEvent.click(screen.getByRole("button", { name: /蓝发/ }));
    expect(change).toHaveBeenCalledTimes(1);
    expect(popup()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "按“发色”任一标签查找" }));
    expect(change).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(popup()).toBeNull());
    expect(document.activeElement).toBe(hairBtn);
  });

  it("“任一成员”再点一次是取消，不叠一条一样的条件", async () => {
    const change = vi.fn();
    const red = { kind: "tag" as const, id: "red", dismissed: [] };
    const green = { kind: "tag" as const, id: "green", dismissed: [] };
    const blue = { conditions: [{ any: [{ kind: "tag" as const, id: "blue", dismissed: [] }], negate: false }], exact: false };
    const view = render(bar({ onChange: change, input: blue }));
    fireEvent.click(await button(/瞳色/));
    const any = screen.getByRole("button", { name: "按“瞳色”任一标签查找" });
    expect(any.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(any);
    expect(change).toHaveBeenLastCalledWith({ ...blue, conditions: [...blue.conditions, { any: [red, green], negate: false }] });
    const on = { ...blue, conditions: [...blue.conditions, { any: [green, red], negate: false }] };
    view.rerender(bar({ onChange: change, input: on }));
    fireEvent.click(await button(/瞳色/));
    const pressed = screen.getByRole("button", { name: "按“瞳色”任一标签查找" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(change).toHaveBeenLastCalledWith(blue);
  });

  it("条件里重复的同一标签不算整组都选了", async () => {
    const red = { kind: "tag" as const, id: "red", dismissed: [] };
    render(bar({ input: { conditions: [{ any: [red, red], negate: false }], exact: false } }));
    fireEvent.click(await button(/瞳色/));
    expect(screen.getByRole("button", { name: "按“瞳色”任一标签查找" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("词表刷新时弹层留着并显示新数据；所开的组没了就关闭", async () => {
    const view = render(bar());
    fireEvent.click(await button(/发色/));
    groups = [{ ...hair, tags: [tag("blue", "蓝发"), tag("pink", "粉发")] }, eyes];
    view.rerender(bar({ generation: 1 }));
    expect(popup()).toBeTruthy();
    expect(await screen.findByRole("button", { name: /粉发/ })).toBeTruthy();
    groups = [eyes];
    view.rerender(bar({ generation: 2 }));
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("安全模式切换立刻收掉弹层，不留旧视角的标签", async () => {
    const view = render(bar());
    fireEvent.click(await button(/发色/));
    expect(screen.getByRole("button", { name: /蓝发/ })).toBeTruthy();
    view.rerender(bar({ safe: true }));
    expect(screen.queryByRole("button", { name: /蓝发/ })).toBeNull();
    expect(popup()).toBeNull();
  });
});
