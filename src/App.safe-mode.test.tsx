import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Candidate } from "./bindings/Candidate";
import type { SearchInput } from "./bindings/SearchInput";
import { App } from "./App";
import { library, label, candidates, resolved, calls, safeOn, setKeepSelectionOnSafeMode, setSafeOn, clean, backend, LocalSearchFixture, sent, selectionPanel, selectionBar, push } from "./App.fixtures";

describe("安全模式", () => {
  const book = () => screen.findByRole("button", { name: /安全模式/ });
  const cardOf = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  const changed = (on: boolean) => push({ kind: "safeModeChanged", libraryId: "L1", on });

  it("新装默认开启；点封印书或按 Ctrl+Shift+S 切换", async () => {
    backend(library);
    render(<App />);
    const button = await book();
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(sent("plugin:library|set_safe_mode")).toEqual([{ on: false }]));

    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(sent("plugin:library|set_safe_mode")).toEqual([{ on: false }, { on: true }]),
    );
  });

  it("开启的同一刻遮住将被封印的图，资料库确认后它们离开图片墙", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")?.dataset.veiled).toBe("false"));
    expect(cardOf("a")?.dataset.veiled).toBe("false");

    fireEvent.click(await book());
    // 不等后端：点下的这一帧就开始遮蔽。
    expect(cardOf("x") === null || cardOf("x")?.dataset.veiled === "true").toBe(true);
    expect(cardOf("a") === null || cardOf("a")?.dataset.veiled === "false").toBe(true);

    await changed(true);
    await waitFor(() => expect(cardOf("x")).toBeNull());
    expect(cardOf("a")).toBeTruthy();
  });

  it("关闭后被封印的图回到图片墙；释放未播完时再开启，立即重新遮住", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    expect(cardOf("x")).toBeNull();

    fireEvent.click(await book());
    await changed(false);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    await waitFor(() => expect(cardOf("x")?.dataset.veiled).toBe("false"));

    fireEvent.click(await book());
    expect(cardOf("x") === null || cardOf("x")?.dataset.veiled === "true").toBe(true);
  });

  it("关闭：开关当即显示为关，后端确认后只整批浏览一次，资料库事件不再重读（#183）", async () => {
    let commit: (on: boolean) => void = () => {};
    backend(library, clean, (cmd) => {
      if (cmd !== "plugin:library|set_safe_mode") return undefined;
      return new Promise<boolean>((resolve) => { commit = (value) => { setSafeOn(value); resolve(value); }; });
    });
    render(<App />);
    await screen.findAllByRole("img");
    const button = await book();
    const before = sent("plugin:library|browse").length;

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(sent("plugin:library|set_safe_mode")).toEqual([{ on: false }]));
    // 后端还没提交：不按关闭发出注定被拒绝或作废的浏览。
    await act(async () => {});
    expect(sent("plugin:library|browse").length).toBe(before);

    // 资料库事件先于命令返回到达，也不提前放开、不重读。
    await changed(false);
    expect(sent("plugin:library|browse").length).toBe(before);
    expect(cardOf("x")).toBeNull();

    const committedAt = calls.length;
    await act(async () => { commit(false); });
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    await act(async () => {});
    expect(sent("plugin:library|browse").length).toBe(before + 1);
    // 后端按到达顺序在同一把锁上排队：图片墙的浏览先发出，状态、侧栏等刷新排在它后面。
    const after = calls.slice(committedAt).map((c) => c.cmd)
      .filter((cmd) => cmd === "plugin:library|browse" || cmd === "plugin:library|registered_libraries");
    expect(after[0]).toBe("plugin:library|browse");
  });

  it("快速关了又开、返回乱序：最后停在开启，旧的关闭不放开视角（#183）", async () => {
    const replies: ((on: boolean) => void)[] = [];
    backend(library, clean, (cmd, args) => {
      if (cmd !== "plugin:library|set_safe_mode") return undefined;
      // 后端按点击顺序提交；返回由测试控制。
      setSafeOn((args as { on: boolean }).on);
      return new Promise<boolean>((resolve) => replies.push(resolve));
    });
    render(<App />);
    await screen.findAllByRole("img");
    const button = await book();
    const before = sent("plugin:library|browse").length;

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(replies.length).toBe(2));
    // 后点的开启先返回，先点的关闭后返回。
    await act(async () => { replies[1](true); });
    await act(async () => { replies[0](false); });
    await waitFor(() => expect(sent("plugin:library|safe_mode").length).toBeGreaterThan(1));
    await act(async () => {});
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(cardOf("x")).toBeNull();
    expect(sent("plugin:library|browse").length).toBe(before);
  });

  it("关闭失败：保持开启，不露出被封印的图", async () => {
    backend(library, clean, (cmd) => cmd === "plugin:library|set_safe_mode" ? Promise.reject("写不进设置") : undefined);
    render(<App />);
    await screen.findAllByRole("img");
    const button = await book();
    const before = sent("plugin:library|browse").length;

    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    await act(async () => {});
    expect(sent("plugin:library|browse").length).toBe(before);
    expect(cardOf("x")).toBeNull();
  });

  it("开启后清掉选中的图，侧栏计数随之刷新", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    fireEvent.keyDown(cardOf("x")!, { key: " " });
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
    const sidebars = sent("plugin:library|sidebar").length;

    fireEvent.click(await book());
    await changed(true);
    await waitFor(() => expect(selectionPanel()).toBeNull());
    await waitFor(() => expect(sent("plugin:library|sidebar").length).toBeGreaterThan(sidebars));
  });

  it("默认关闭安全模式时也清空选择", async () => {
    backend(library);
    render(<App />);
    await waitFor(() => expect(cardOf("a")).toBeTruthy());
    fireEvent.keyDown(cardOf("a")!, { key: " " });
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();

    fireEvent.click(await book());
    await changed(false);
    await waitFor(() => expect(selectionPanel()).toBeNull());
    expect(cardOf("a")).toBeTruthy();
  });

  /** 等设置读到后再选择，避免按默认值清空。 */
  const keepSelection = async () => {
    await waitFor(() => expect(sent("shell_settings").length).toBeGreaterThan(0));
    await act(async () => {});
  };

  it("设为切换时保留选择后，开启只去掉被封印的选中图", async () => {
    setKeepSelectionOnSafeMode(true);
    backend(library, clean, undefined, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    await keepSelection();
    fireEvent.keyDown(cardOf("a")!, { key: " " });
    fireEvent.click(cardOf("x")!, { ctrlKey: true });
    expect(screen.getByText("已选 2 张")).toBeTruthy();

    fireEvent.click(await book());
    await changed(true);
    await waitFor(() => expect(cardOf("x")).toBeNull());
    await waitFor(() => expect(selectionBar()).toBeNull()); expect(selectionPanel()).toBeTruthy();
    expect(cardOf("a")?.getAttribute("aria-selected")).toBe("true");
  });

  it("设为切换时保留选择后，关闭安全模式保持选择", async () => {
    setKeepSelectionOnSafeMode(true);
    backend(library);
    render(<App />);
    await waitFor(() => expect(cardOf("a")).toBeTruthy());
    await keepSelection();
    fireEvent.keyDown(cardOf("a")!, { key: " " });

    fireEvent.click(await book());
    await changed(false);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    expect(selectionPanel()).toBeTruthy(); expect(selectionBar()).toBeNull();
    expect(cardOf("a")?.getAttribute("aria-selected")).toBe("true");
  });
  describe("候选随视角作废（#76）", () => {
    const adult: Candidate = { tag: label("ADULT", "general", "只在成人图出现的标签"), via: null, count: 1 };
    const box = () => screen.findByRole("combobox", { name: "查找参考图" });
    /** 后端核对请求带的视角：与资料库的安全模式不同时拒绝，与真实命令一致。 */
    const lensChecked = (hold?: () => Promise<Candidate[]> | undefined) => (cmd: string, args: unknown) => {
      if (cmd !== "plugin:library|search_candidates") return undefined;
      const { text, safeMode } = args as { text: string; safeMode: boolean };
      const held = hold?.();
      if (held) return held;
      if (safeMode !== safeOn) return Promise.reject({ code: "lensChanged" });
      return text.trim() && !safeOn ? [adult] : [];
    };

    it.each(["封印书", "快捷键"])("用%s开启安全模式时立即清掉成人图独有的候选与数量，重新聚焦也不再出现", async (entry) => {
      backend(library, clean, lensChecked(), false);
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      expect(await screen.findByRole("option", { name: /只在成人图出现的标签/ })).toBeTruthy();

      if (entry === "封印书") fireEvent.click(await book());
      else fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      // 不等后端确认，也不用再打字。
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
      expect(document.querySelector(".k-option .k-item-meta")).toBeNull();

      await changed(true);
      fireEvent.blur(input);
      fireEvent.focus(input);
      await waitFor(() =>
        expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ text: "只在成人", safeMode: true }),
      );
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("切换前发出的候选请求迟到时不写回新视角", async () => {
      let finish!: (value: Candidate[]) => void;
      const late = new Promise<Candidate[]>((resolve) => { finish = resolve; });
      let first = true;
      backend(library, clean, lensChecked(() => {
        if (!first) return undefined;
        first = false;
        return late;
      }), false);
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(1));
      fireEvent.click(await book());
      await changed(true);
      await act(async () => {
        finish([adult]);
        await late;
      });
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
    });

    it("关闭后候选按新视角重新取得，再开启时又立即清掉", async () => {
      backend(library, clean, lensChecked());
      render(<App />);
      await screen.findAllByRole("img");
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("plugin:library|search_candidates")).toHaveLength(1));
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();

      fireEvent.click(await book());
      await changed(false);
      expect(await screen.findByRole("option", { name: /只在成人图出现的标签/ })).toBeTruthy();

      fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
    });

    it("词表变化后重新取得候选", async () => {
      let names = ["旧名"];
      backend(library, clean, (cmd) =>
        cmd === "plugin:library|search_candidates"
          ? names.map((name) => ({ tag: label(name, "general", name), via: null, count: 1 }))
          : undefined,
      );
      render(<App />);
      const input = await box();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "名" } });
      expect(await screen.findByRole("option", { name: /旧名/ })).toBeTruthy();
      names = ["新名"];
      await push({ kind: "vocabularyChanged", libraryId: "L1", revision: 9 });
      expect(await screen.findByRole("option", { name: /新名/ })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /旧名/ })).toBeNull();
    });

    it("“加相近标签”的候选同样随视角作废，迟到的响应不写回", async () => {
      let finish!: (value: Candidate[]) => void;
      const late = new Promise<Candidate[]>((resolve) => { finish = resolve; });
      let holding = false;
      backend(library, clean, (cmd, args) => {
        if (cmd !== "plugin:library|search_candidates") return undefined;
        const { text, safeMode } = args as { text: string; safeMode: boolean };
        if (text === "只在成人" && holding) {
          holding = false;
          return late;
        }
        if (safeMode !== safeOn) return Promise.reject({ code: "lensChanged" });
        if (text === "只在成人") return safeOn ? [] : [adult];
        return text.trim() ? candidates : [];
      }, false);
      render(<LocalSearchFixture />);
      const input = await box();
      fireEvent.change(input, { target: { value: "蓝" } });
      fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      const dialog = screen.getByRole("dialog", { name: "加相近标签" });
      const pick = within(dialog).getByRole("combobox", { name: "挑一个库内标签" });
      fireEvent.change(pick, { target: { value: "只在成人" } });
      expect(await screen.findByRole("option", { name: /只在成人图出现的标签/ })).toBeTruthy();

      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
      await changed(true);
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      const safeDialog = screen.getByRole("dialog", { name: "加相近标签" });
      fireEvent.change(within(safeDialog).getByRole("combobox"), { target: { value: "只在成人" } });
      await waitFor(() => expect(sent("plugin:library|search_candidates").at(-1)).toMatchObject({ text: "只在成人", safeMode: true }));
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();

      // An unsafe request may finish after its dialog and lens have been revoked.
      holding = true;
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      await changed(false);
      fireEvent.click(await screen.findByRole("button", { name: "给“蓝发”加相近标签" }));
      fireEvent.change(within(screen.getByRole("dialog", { name: "加相近标签" })).getByRole("combobox"), { target: { value: "只在成人" } });
      await waitFor(() => expect(holding).toBe(false));
      fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true });
      await changed(true);
      await act(async () => { finish([adult]); await late; });
      expect(screen.queryByRole("dialog", { name: "加相近标签" })).toBeNull();
      expect(screen.queryByRole("option", { name: /只在成人图出现的标签/ })).toBeNull();
    });

    it("条件解析带上当前视角，视角刚切换的拒绝不当作错误显示", async () => {
      backend(library, clean, (cmd, args) => {
        if (cmd !== "plugin:library|resolve_search") return undefined;
        const { input, safeMode } = args as { input: SearchInput; safeMode: boolean };
        if (safeMode !== safeOn) return Promise.reject({ code: "lensChanged" });
        return resolved(input);
      }, false);
      render(<App />);
      await waitFor(() => expect(cardOf("x")).toBeTruthy());
      const input = await box();
      fireEvent.change(input, { target: { value: "蓝" } });
      fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
      await waitFor(() => expect(sent("plugin:library|resolve_search").at(-1)).toMatchObject({ safeMode: false }));
      fireEvent.click(await book());
      await waitFor(() => expect(sent("plugin:library|resolve_search").at(-1)).toMatchObject({ safeMode: true }));
      await changed(true);
      await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("水色发"));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});

