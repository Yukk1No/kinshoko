import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import {
  library,
  clean,
  calls,
  setKeepSelectionOnSafeMode,
  setSafeOn,
  backend,
  sent,
  selectionPanel,
  selectionBar,
} from "./App.fixtures";
import type { Args } from "./test/backend";
import { cardOf, safeModeButton as book, safeModeChanged as changed } from "./App.safe-mode.fixtures";

describe("安全模式", () => {
  it("新装默认开启；点封印书或按 Ctrl+Shift+S 切换", async () => {
    backend(library);
    render(<App />);
    const button = await book();
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(sent("set_safe_mode")).toEqual([{ on: false }]));

    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(sent("set_safe_mode")).toEqual([{ on: false }, { on: true }]));
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
    backend(library, clean, {
      set_safe_mode: () =>
        new Promise<boolean>((resolve) => {
          commit = (value) => {
            setSafeOn(value);
            resolve(value);
          };
        }),
    });
    render(<App />);
    await screen.findAllByRole("img");
    const button = await book();
    const before = sent("workspace_browse").length;

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(sent("set_safe_mode")).toEqual([{ on: false }]));
    // 后端还没提交：不按关闭发出注定被拒绝或作废的浏览。
    await act(async () => {});
    expect(sent("workspace_browse").length).toBe(before);

    // 资料库事件先于命令返回到达，也不提前放开、不重读。
    await changed(false);
    expect(sent("workspace_browse").length).toBe(before);
    expect(cardOf("x")).toBeNull();

    const committedAt = calls().length;
    await act(async () => {
      commit(false);
    });
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    await act(async () => {});
    expect(sent("workspace_browse").length).toBe(before + 1);
    // 后端按到达顺序在同一把锁上排队：图片墙的浏览先发出，状态、侧栏等刷新排在它后面。
    const after = calls()
      .slice(committedAt)
      .map((c) => c.command)
      .filter((command) => command === "workspace_browse" || command === "workspace_status");
    expect(after[0]).toBe("workspace_browse");
  });

  it("快速关了又开、返回乱序：最后停在开启，旧的关闭不放开视角（#183）", async () => {
    const replies: ((on: boolean) => void)[] = [];
    backend(library, clean, {
      set_safe_mode: (args: Args) => {
        // 后端按点击顺序提交；返回由测试控制。
        setSafeOn((args as { on: boolean }).on);
        return new Promise<boolean>((resolve) => replies.push(resolve));
      },
    });
    render(<App />);
    await screen.findAllByRole("img");
    const button = await book();
    const before = sent("workspace_browse").length;

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(replies.length).toBe(2));
    // 后点的开启先返回，先点的关闭后返回。
    await act(async () => {
      replies[1](true);
    });
    await act(async () => {
      replies[0](false);
    });
    await waitFor(() => expect(sent("safe_mode").length).toBeGreaterThan(1));
    await act(async () => {});
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(cardOf("x")).toBeNull();
    expect(sent("workspace_browse").length).toBe(before);
  });

  it("关闭失败：保持开启，不露出被封印的图", async () => {
    backend(library, clean, { set_safe_mode: () => Promise.reject("写不进设置") });
    render(<App />);
    await screen.findAllByRole("img");
    const button = await book();
    const before = sent("workspace_browse").length;

    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    await act(async () => {});
    expect(sent("workspace_browse").length).toBe(before);
    expect(cardOf("x")).toBeNull();
  });

  it("开启后清掉选中的图，侧栏计数随之刷新", async () => {
    backend(library, clean, undefined, false);
    render(<App />);
    await waitFor(() => expect(cardOf("x")).toBeTruthy());
    fireEvent.keyDown(cardOf("x")!, { key: " " });
    expect(selectionPanel()).toBeTruthy();
    expect(selectionBar()).toBeNull();
    const sidebars = sent("workspace_directories").length;

    fireEvent.click(await book());
    await changed(true);
    await waitFor(() => expect(selectionPanel()).toBeNull());
    await waitFor(() => expect(sent("workspace_directories").length).toBeGreaterThan(sidebars));
  });

  it("默认关闭安全模式时也清空选择", async () => {
    backend(library);
    render(<App />);
    await waitFor(() => expect(cardOf("a")).toBeTruthy());
    fireEvent.keyDown(cardOf("a")!, { key: " " });
    expect(selectionPanel()).toBeTruthy();
    expect(selectionBar()).toBeNull();

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
    await waitFor(() => expect(selectionBar()).toBeNull());
    expect(selectionPanel()).toBeTruthy();
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
    expect(selectionPanel()).toBeTruthy();
    expect(selectionBar()).toBeNull();
    expect(cardOf("a")?.getAttribute("aria-selected")).toBe("true");
  });
});
