import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cssRule } from "./cssRule";
import { DialogHeight, DialogSwap } from "./DialogHeight";
import settings from "./settings.css?raw";
import ui from "./uiCss";
import tokens from "../styles/tokens.css?raw";
import { flatCss } from "../test/flatCss";
import { resize, setMedia } from "../test/platform";

// jsdom 不排版：内层高度由测试给，外层在 height 为 auto 时等于内层（不超过上限）。
let content = 100;
let cap = Infinity;
// 每次读外层高度时记下当时写着的 height，用来确认过渡的起点。
let readsWhileSet: string[] = [];

const outerOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".k-dialog-height")!;

function changeTo(height: number) {
  content = height;
  act(() => resize(document.querySelector(".k-dialog-height-inner")!));
}

beforeEach(() => {
  content = 100;
  cap = Infinity;
  readsWhileSet = [];
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("k-dialog-height-inner")) return content;
    if (this.style.height) readsWhileSet.push(this.style.height);
    return this.style.height ? parseFloat(this.style.height) : Math.min(content, cap);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DialogHeight", () => {
  it("内容变高时从旧高度过渡到新高度，结束后回到 auto", () => {
    const { container } = render(<DialogHeight>内容</DialogHeight>);
    const outer = outerOf(container);
    expect(outer.style.height).toBe("");

    changeTo(300);
    expect(readsWhileSet).toEqual(["100px"]);
    expect(outer.style.height).toBe("300px");
    expect(outer.hasAttribute("data-moving")).toBe(true);

    fireEvent.transitionEnd(outer, { propertyName: "height" });
    expect(outer.style.height).toBe("");
    expect(outer.hasAttribute("data-moving")).toBe(false);
  });

  it("子元素自己的过渡结束不算", () => {
    const { container } = render(
      <DialogHeight>
        <span data-testid="child">内容</span>
      </DialogHeight>,
    );
    changeTo(300);
    fireEvent.transitionEnd(screen.getByTestId("child"), { propertyName: "height" });
    expect(outerOf(container).style.height).toBe("300px");
  });

  it("系统要求减少动画时直接到终态", () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    const { container } = render(<DialogHeight>内容</DialogHeight>);
    changeTo(300);
    const outer = outerOf(container);
    expect(outer.style.height).toBe("");
    expect(outer.hasAttribute("data-moving")).toBe(false);
  });

  it("已经停在上限、内容继续变高时不过渡，留给滚动", () => {
    cap = 400;
    content = 500;
    const { container } = render(<DialogHeight>内容</DialogHeight>);
    changeTo(900);
    const outer = outerOf(container);
    expect(outer.style.height).toBe("");
    expect(outer.hasAttribute("data-moving")).toBe(false);
  });

  it("从上限以内长到超出时只过渡到上限", () => {
    cap = 400;
    const { container } = render(<DialogHeight>内容</DialogHeight>);
    changeTo(900);
    expect(outerOf(container).style.height).toBe("400px");
  });

  it("过渡途中内容再变，从当前高度转向新目标", () => {
    const { container } = render(<DialogHeight>内容</DialogHeight>);
    const outer = outerOf(container);
    changeTo(300);
    readsWhileSet = [];
    changeTo(200);
    expect(readsWhileSet[0]).toBe("300px");
    expect(outer.style.height).toBe("200px");
    fireEvent.transitionEnd(outer, { propertyName: "height" });
    expect(outer.style.height).toBe("");
  });

  it("过渡只用令牌，令牌在减弱动效下为 0", () => {
    expect(cssRule(ui, ".k-dialog-height[data-moving]").transition).toBe("height var(--t-slow) var(--ease)");
    expect(flatCss(tokens)).toMatch(/prefers-reduced-motion: reduce\) \{ :root \{[^}]*--t-slow: 0ms/);
  });
});

describe("设置对话框", () => {
  it("有起始高度，只有长页才长高，上限不变；滚动条位置常留", () => {
    const dialog = cssRule(settings, ".k-dialog.k-settings-dialog");
    expect(dialog.height).toBeUndefined();
    expect(dialog["min-height"]).toBe("min(480px, calc(100vh - 48px))");
    expect(dialog["max-height"]).toBe("var(--k-settings-max)");
    expect(cssRule(settings, ".k-dialog-height.k-set-main")["scrollbar-gutter"]).toBe("stable");
  });
});

describe("DialogSwap", () => {
  it("减弱动效下旧内容立刻换成新内容", () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    const { rerender } = render(<DialogSwap step={0}>第一步</DialogSwap>);
    rerender(<DialogSwap step={1}>第二步</DialogSwap>);
    expect(screen.queryByText("第一步")).toBeNull();
    screen.getByText("第二步");
  });

  it("退场中的旧内容不可操作，结束后移除", async () => {
    const { rerender } = render(
      <DialogSwap step={0}>
        <button type="button">旧</button>
      </DialogSwap>,
    );
    rerender(
      <DialogSwap step={1}>
        <button type="button">新</button>
      </DialogSwap>,
    );
    screen.getByRole("button", { name: "新" });
    expect(screen.queryByRole("button", { name: "旧" })).toBeNull();
    await waitFor(() => expect(screen.queryByText("旧")).toBeNull());
  });

  it("外面滚动过时，新内容从顶部开始，旧内容留在原来看到的位置", () => {
    const { container, rerender } = render(
      <DialogHeight>
        <DialogSwap step={0}>甲页</DialogSwap>
      </DialogHeight>,
    );
    const outer = outerOf(container);
    outer.scrollTop = 300;
    rerender(
      <DialogHeight>
        <DialogSwap step={1}>乙页</DialogSwap>
      </DialogHeight>,
    );
    expect(outer.scrollTop).toBe(0);
    expect(screen.getByText("甲页").closest<HTMLElement>("[inert]")!.style.translate).toBe("0 -300px");
    expect(screen.getByText("乙页").style.translate).toBe("");
  });

  it("减弱动效下外面滚动过时，新内容同样从顶部开始", () => {
    setMedia("(prefers-reduced-motion: reduce)", true);
    const { container, rerender } = render(
      <DialogHeight>
        <DialogSwap step={0}>丙页</DialogSwap>
      </DialogHeight>,
    );
    const outer = outerOf(container);
    outer.scrollTop = 300;
    rerender(
      <DialogHeight>
        <DialogSwap step={1}>丁页</DialogSwap>
      </DialogHeight>,
    );
    expect(outer.scrollTop).toBe(0);
  });

  it("首次出现不播放进场", () => {
    const { container } = render(<DialogSwap step={3}>内容</DialogSwap>);
    expect(container.querySelector<HTMLElement>(".k-dialog-swap-step")!.style.opacity).not.toBe("0");
  });
});
