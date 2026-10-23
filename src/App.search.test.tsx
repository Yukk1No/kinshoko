import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Candidate } from "./bindings/Candidate";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import { App } from "./App";
import { library, candidates, resolved, setShowApproxSource, clean, backend, LocalSearchFixture, sent, openLibrary } from "./App.fixtures";

describe("查找", () => {
  const box = () => screen.findByRole("combobox", { name: "查找参考图" });
  const lastInput = () => (sent("plugin:library|resolve_search").at(-1) as { input: SearchInput }).input;
  const lastQuery = () =>
    (sent("plugin:library|browse").at(-1) as { query: { conditions: ConditionTree } }).query;

  it("切换整理资料库保留全局条件，旧候选和旧条件树按代次重新解析", async () => {
    const other = { id: "L2", name: "私人收藏", root: "E:\\私人收藏" };
    let finishCandidates!: (value: Candidate[]) => void;
    let finishTree!: (value: ConditionTree) => void;
    const oldCandidates = new Promise<Candidate[]>((resolve) => { finishCandidates = resolve; });
    const oldTree = new Promise<ConditionTree>((resolve) => { finishTree = resolve; });
    let requests = 0;
    backend(library, clean, (cmd) => {
      if (cmd === "plugin:library|registered_libraries") return [library, other].map((library) => ({ library, unavailable: null }));
      if (cmd === "plugin:library|switch_library") return other;
      if (cmd === "plugin:library|resolve_search") return oldTree;
      if (cmd === "plugin:library|search_candidates") return requests++ === 0 ? oldCandidates : [];
      return undefined;
    });
    render(<App />);
    const input = await box();
    fireEvent.change(input, { target: { value: "某" } });
    await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sent("plugin:library|resolve_search")).toHaveLength(1));
    await openLibrary();
    fireEvent.change(await box(), { target: { value: "某" } });
    await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(2));
    await act(() => {
      finishCandidates(candidates);
      finishTree(resolved({ conditions: [{ any: [{ kind: "text", text: "旧库条件", dismissed: [] }], negate: false }], exact: false }));
    });

    expect(within(screen.getByRole("listbox", { name: "" })).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("list", { name: "查找条件" }).children).toHaveLength(1);
    expect(lastQuery().conditions.conditions).toHaveLength(1);
    expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ libraryId: "L2" });
    expect(sent("plugin:library|resolve_search")[0]).toMatchObject({ libraryId: "L1" });
  });

  it("输入的词命中多个命名空间与别名时，下拉按命名空间与别名列出候选", async () => {
    backend(library);
    render(<App />);
    fireEvent.change(await box(), { target: { value: "某某" } });

    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "" })).getAllByRole("option")).toHaveLength(4));
    expect(within(screen.getByRole("listbox", { name: "" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "查找“某某”",
      "角色：某某8",
      "作者：某某3",
      "蓝发又名：某某色1",
    ]);
    expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ text: "某某", lang: "zh-CN" });
  });

  it("不选候选直接回车就按文字查找，点选候选只查这个标签；图片墙按条件树重新浏览", async () => {
    backend(library);
    render(<App />);
    const input = await box();
    fireEvent.change(input, { target: { value: "某某" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(lastInput()).toEqual({
        conditions: [{ any: [{ kind: "text", text: "某某", dismissed: [] }], negate: false }],
        exact: false,
      }),
    );
    await waitFor(() => expect(lastQuery().conditions).toEqual(resolved(lastInput())));
    const chips = screen.getByRole("list", { name: "查找条件" });
    expect(chips.textContent).toContain("“某某”");
    expect((input as HTMLInputElement).value).toBe("");

    fireEvent.change(input, { target: { value: "某" } });
    fireEvent.click(await screen.findByRole("option", { name: /作者：某某/ }));
    await waitFor(() => expect(lastInput().conditions).toHaveLength(2));
    expect(lastInput().conditions[1]).toEqual({ any: [{ kind: "tag", id: "A", dismissed: [] }], negate: false });
    await waitFor(() => expect(lastQuery().conditions.conditions).toHaveLength(2));
    expect(chips.textContent).toContain("作者：某某");
  });

  it("Alt+回车或 Ctrl 点选把候选加进上一个条件作为“任一”；可以排除或去掉条件", async () => {
    backend(library);
    render(<App />);
    const input = await box();
    fireEvent.change(input, { target: { value: "蓝" } });
    fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
    await waitFor(() => expect(lastInput().conditions).toHaveLength(1));

    fireEvent.change(input, { target: { value: "某" } });
    fireEvent.click(await screen.findByRole("option", { name: /角色：某某/ }), { ctrlKey: true });
    await waitFor(() =>
      expect(lastInput().conditions).toEqual([
        {
          any: [
            { kind: "tag", id: "B", dismissed: [] },
            { kind: "tag", id: "C", dismissed: [] },
          ],
          negate: false,
        },
      ]),
    );
    fireEvent.change(input, { target: { value: "紫发" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    await waitFor(() => expect(lastInput().conditions[0].any).toHaveLength(3));
    expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("或");

    fireEvent.click(screen.getByRole("button", { name: "排除这个条件" }));
    await waitFor(() => expect(lastInput().conditions[0].negate).toBe(true));
    expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("不要");

    fireEvent.click(screen.getByRole("button", { name: "去掉这个条件" }));
    await waitFor(() => expect(lastQuery().conditions).toEqual({ conditions: [] }));
  });
});

describe("近似查找", () => {
  const box = () => screen.findByRole("combobox", { name: "查找参考图" });
  const chips = () => screen.getByRole("list", { name: "查找条件" });
  const lastInput = () => (sent("plugin:library|resolve_search").at(-1) as { input: SearchInput }).input;

  /** 点选“蓝发”作为一个条件。 */
  async function pickBlue() {
    const input = await box();
    fireEvent.change(input, { target: { value: "蓝" } });
    fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
    await waitFor(() => expect(chips().textContent).toContain("水色发"));
  }

  it("默认在条件里列出展开的相近标签，一键改回精确查找", async () => {
    backend(library);
    render(<App />);
    await pickBlue();
    expect(chips().textContent).toContain("蓝发或相近：水色发");
    expect(chips().textContent).not.toContain("内置");

    fireEvent.click(screen.getByRole("button", { name: "精确查找", pressed: false }));

    await waitFor(() => expect(lastInput().exact).toBe(true));
    await waitFor(() => expect(chips().textContent).not.toContain("水色发"));
    expect(screen.getByRole("button", { name: "精确查找", pressed: true })).toBeTruthy();
  });

  it("关掉一个相近标签时，“只这次”只改本次条件，“以后都不展开”记进个人近似对应表", async () => {
    backend(library);
    render(<LocalSearchFixture />);
    await pickBlue();

    fireEvent.click(screen.getByRole("button", { name: "不展开“水色发”" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "不展开相近标签" })).getByRole("button", { name: "只这次" }));
    await waitFor(() =>
      expect(lastInput().conditions[0].any[0]).toEqual({ kind: "tag", id: "B", dismissed: ["Q"] }),
    );
    await waitFor(() => expect(chips().textContent).not.toContain("水色发"));
    expect(sent("plugin:library|set_tag_approx")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "去掉这个条件" }));
    await pickBlue();
    fireEvent.click(screen.getByRole("button", { name: "不展开“水色发”" }));
    fireEvent.click(screen.getByRole("button", { name: "以后都不展开" }));
    await waitFor(() =>
      expect(sent("plugin:library|set_tag_approx")).toEqual([{ libraryId: "L1", a: "B", b: "Q", relation: "notSimilar" }]),
    );
    expect(screen.queryByRole("dialog", { name: "不展开相近标签" })).toBeNull();
  });

  it("用“＋”从库内标签里挑一个加为相近标签", async () => {
    backend(library);
    render(<LocalSearchFixture />);
    await pickBlue();

    fireEvent.click(screen.getByRole("button", { name: "给“蓝发”加相近标签" }));
    const dialog = screen.getByRole("dialog", { name: "加相近标签" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "挑一个库内标签" }), {
      target: { value: "某" },
    });
    fireEvent.click(await within(dialog).findByRole("option", { name: /作者：某某/ }));

    await waitFor(() =>
      expect(sent("plugin:library|set_tag_approx")).toEqual([{ libraryId: "L1", a: "B", b: "A", relation: "similar" }]),
    );
    expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
  });

  it("设置中开启来源标记后，相近标签旁标出来自内置还是个人近似对应表", async () => {
    setShowApproxSource(true);
    backend(library);
    render(<App />);
    await pickBlue();

    await waitFor(() => expect(chips().textContent).toContain("水色发内置"));
  });

  it("没有外部对应的标签旁显示提示图标，有外部对应的不显示", async () => {
    backend(library);
    render(<App />);
    await pickBlue();

    const hints = within(chips()).getAllByRole("img", { name: "没有外部对应，不参与内置近似对应表" });
    expect(hints).toHaveLength(1);
    expect(hints[0].previousElementSibling?.textContent).toBe("蓝发");
  });
});

describe("界面缩放", () => {
  const scaleBackend = (saved: number) => {
    let current = saved;
    backend(library, clean, (cmd, args) => {
      if (cmd === "ui_scale") return current;
      if (cmd === "set_ui_scale") return (current = (args as { percent: number }).percent);
      return undefined;
    });
  };
  const key = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });

  it("Ctrl+= 放大一档、Ctrl+- 缩小一档、Ctrl+0 复位到 100%，从保存的档位开始", async () => {
    scaleBackend(125);
    render(<App />);
    await screen.findAllByRole("img");
    await waitFor(() => expect(sent("ui_scale")).toHaveLength(1));
    await act(async () => {});

    key("=");
    await waitFor(() => expect(sent("set_ui_scale")).toEqual([{ percent: 150 }]));
    key("-");
    key("-");
    await waitFor(() => expect(sent("set_ui_scale")).toEqual([{ percent: 150 }, { percent: 125 }, { percent: 110 }]));
    key("0");
    await waitFor(() => expect(sent("set_ui_scale").at(-1)).toEqual({ percent: 100 }));
  });

  it("连按时写入一次只发一个，上一个完成后再写最后按到的那一档，不会被旧的覆盖", async () => {
    const pending: (() => void)[] = [];
    let current = 100;
    backend(library, clean, (cmd, args) => {
      if (cmd === "ui_scale") return current;
      if (cmd === "set_ui_scale") {
        const { percent } = args as { percent: number };
        return new Promise((resolve) => pending.push(() => resolve((current = percent))));
      }
      return undefined;
    });
    render(<App />);
    await screen.findAllByRole("img");
    await waitFor(() => expect(sent("ui_scale")).toHaveLength(1));
    await act(async () => {});

    key("=");
    key("=");
    key("=");
    await waitFor(() => expect(sent("set_ui_scale")).toEqual([{ percent: 110 }]));
    await act(async () => { pending.shift()!(); });

    await waitFor(() => expect(sent("set_ui_scale")).toEqual([{ percent: 110 }, { percent: 150 }]));
    await act(async () => { pending.shift()!(); });
    await act(async () => {});
    expect(sent("set_ui_scale")).toHaveLength(2);
    expect(current).toBe(150);
  });

  it("到最高、最低档后再按不动作", async () => {
    scaleBackend(200);
    render(<App />);
    await screen.findAllByRole("img");
    await waitFor(() => expect(sent("ui_scale")).toHaveLength(1));
    await act(async () => {});

    key("=");
    await act(async () => {});
    expect(sent("set_ui_scale")).toEqual([]);
  });

  it("设置 › 通用的下拉框显示当前档位，选中即生效", async () => {
    scaleBackend(90);
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    const select = await screen.findByRole("combobox", { name: "界面缩放" }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("90"));

    fireEvent.change(select, { target: { value: "175" } });
    await waitFor(() => expect(sent("set_ui_scale")).toEqual([{ percent: 175 }]));
    await waitFor(() => expect(select.value).toBe("175"));
  });
});

