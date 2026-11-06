import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DensityIsland } from "./DensityIsland";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const setup = (value = 240) => {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(<DensityIsland value={value} onPreview={onPreview} onCommit={onCommit} />);
  return { onPreview, onCommit, slider: screen.getByRole("slider", { name: "图片大小" }) as HTMLInputElement };
};

it("浮岛里是图片大小滑条，两端是小图与大图", () => {
  const { slider } = setup();
  expect(slider.min).toBe("140");
  expect(slider.max).toBe("420");
  const island = screen.getByRole("group", { name: "图片大小" });
  expect(island.contains(slider)).toBe(true);
  expect(island.querySelector('[data-end="small"]')).toBeTruthy();
  expect(island.querySelector('[data-end="large"]')).toBeTruthy();
});

it("拖动时只预览，松手才提交", () => {
  const { slider, onPreview, onCommit } = setup();
  fireEvent.pointerDown(slider);
  fireEvent.change(slider, { target: { value: "300" } });
  fireEvent.change(slider, { target: { value: "360" } });
  expect(onPreview).toHaveBeenLastCalledWith(360);
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith(360);
});

it("键盘调整在停手 220 ms 后提交", () => {
  vi.useFakeTimers();
  const { slider, onPreview, onCommit } = setup();
  fireEvent.change(slider, { target: { value: "250" } });
  fireEvent.change(slider, { target: { value: "260" } });
  expect(onPreview).toHaveBeenLastCalledWith(260);
  vi.advanceTimersByTime(219);
  expect(onCommit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onCommit).toHaveBeenCalledWith(260);
});

it("回到原值时撤掉预览，不提交", () => {
  const { slider, onPreview, onCommit } = setup();
  fireEvent.pointerDown(slider);
  fireEvent.change(slider, { target: { value: "300" } });
  fireEvent.change(slider, { target: { value: "240" } });
  fireEvent.pointerUp(slider);
  expect(onPreview).toHaveBeenLastCalledWith(null);
  expect(onCommit).not.toHaveBeenCalled();
});

it("已走过的一段跟随当前值", () => {
  const { slider } = setup(280);
  expect(slider.style.getPropertyValue("--fill")).toBe("50%");
  fireEvent.change(slider, { target: { value: "420" } });
  expect(slider.style.getPropertyValue("--fill")).toBe("100%");
});

it("Ctrl+滚轮缩放的预览让滑条跟着走，撤掉预览后回到已提交的值；不经滑条重复提交", () => {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const view = render(<DensityIsland value={240} preview={290} onPreview={onPreview} onCommit={onCommit} />);
  const slider = screen.getByRole("slider", { name: "图片大小" }) as HTMLInputElement;
  expect(slider.value).toBe("290");
  view.rerender(<DensityIsland value={240} preview={null} onPreview={onPreview} onCommit={onCommit} />);
  expect(slider.value).toBe("240");
  view.rerender(<DensityIsland value={320} preview={null} onPreview={onPreview} onCommit={onCommit} />);
  expect(slider.value).toBe("320");
  expect(onPreview).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});

describe("多选时收成圆形按钮（#180），按钮自身形变为滑条（#452）", () => {
  const setupKnob = (props: { rise?: boolean; onRising?: (rising: boolean) => void } = {}) => {
    const onCommit = vi.fn();
    const view = render(<DensityIsland collapsed value={240} onPreview={() => {}} onCommit={onCommit} {...props} />);
    const slot = screen.getByRole("group", { name: "图片大小" });
    const button = within(slot).getByRole("button", { name: "图片大小" });
    return { onCommit, view, slot, button, shape: slot.querySelector(".k-density-island") as HTMLElement };
  };
  afterEach(() => { document.documentElement.removeAttribute("data-reduced-motion"); });

  it("只剩图片大小按钮；悬停时同一个形状长出滑条，移开后收回", () => {
    const { slot, button, shape, onCommit } = setupKnob();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(shape.hasAttribute("data-open")).toBe(false);

    fireEvent.mouseEnter(slot);
    const slider = screen.getByRole("slider", { name: "图片大小" }) as HTMLInputElement;
    expect(shape.contains(slider)).toBe(true);
    expect(shape.contains(button)).toBe(true);
    expect(shape.hasAttribute("data-open")).toBe(true);
    expect(slot.querySelector(".k-density-pop")).toBeNull();
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "320" } });
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledWith(320);

    fireEvent.mouseLeave(slot);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(slot.querySelector(".k-density-island")).toBe(shape);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("点按展开；按钮排在滑条之前，Tab 能走到滑条；Esc 收回并回焦到按钮，不往外传", () => {
    const { slot, button } = setupKnob();
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const slider = screen.getByRole("slider", { name: "图片大小" });
    expect(button.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    slider.focus();
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(slot.querySelector(".k-density-row")!.hasAttribute("inert")).toBe(true);

    fireEvent.keyDown(button, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("keydown", outer);
  });

  it("拖动时指针移出也不收回，松手才收回；松手时指针还在里面就不收回", () => {
    const { slot, button } = setupKnob();
    fireEvent.mouseEnter(slot);
    const slider = screen.getByRole("slider");
    fireEvent.pointerDown(slider);
    fireEvent.mouseLeave(slot);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerUp(window);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.mouseEnter(slot);
    fireEvent.pointerDown(screen.getByRole("slider"));
    fireEvent.pointerUp(window);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("用鼠标点过滑条之后，移开照样收回", () => {
    const { slot, button } = setupKnob();
    fireEvent.mouseEnter(slot);
    screen.getByRole("slider").focus();
    fireEvent.mouseLeave(slot);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("焦点移出时收回；指针还在上面时不收回", () => {
    const { slot, button } = setupKnob();
    fireEvent.click(button);
    fireEvent.blur(button, { relatedTarget: document.body });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.mouseEnter(slot);
    fireEvent.blur(button, { relatedTarget: document.body });
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("rise 只在展开时升起；收回后回到原位", () => {
    const { slot } = setupKnob({ rise: true });
    expect(slot.hasAttribute("data-rising")).toBe(false);
    fireEvent.mouseEnter(slot);
    expect(slot.hasAttribute("data-rising")).toBe(true);
    fireEvent.mouseLeave(slot);
    expect(slot.hasAttribute("data-rising")).toBe(false);
  });

  it("悬浮栏消失时回到完整浮岛；再次收起时是圆钮，不残留展开", () => {
    const { slot, view } = setupKnob();
    const props = { value: 240, onPreview: () => {}, onCommit: () => {} };
    fireEvent.mouseEnter(slot);
    view.rerender(<DensityIsland {...props} />);
    expect(slot.querySelector('[data-end="large"]')).toBeTruthy();
    expect(within(slot).queryByRole("button")).toBeNull();
    view.rerender(<DensityIsland {...props} collapsed />);
    expect(within(slot).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("减弱动效下直接到终态：内容交替不等动画，展开、收回当帧就到位", () => {
    document.documentElement.setAttribute("data-reduced-motion", "");
    const { slot, button } = setupKnob();
    const row = slot.querySelector(".k-density-row") as HTMLElement;
    expect(row.style.opacity).toBe("0");
    fireEvent.mouseEnter(slot);
    expect(row.style.opacity).toBe("1");
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Escape" });
    expect(document.activeElement).toBe(button);
    expect(row.style.opacity).toBe("0");
  });

  it("升起的状态报告给右下角，让打标小圆点跟着走", () => {
    const onRising = vi.fn();
    const { slot } = setupKnob({ rise: true, onRising });
    expect(onRising).toHaveBeenLastCalledWith(false);
    fireEvent.mouseEnter(slot);
    expect(onRising).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(slot);
    expect(onRising).toHaveBeenLastCalledWith(false);
  });
});
