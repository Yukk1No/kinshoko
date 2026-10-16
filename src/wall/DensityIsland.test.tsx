import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
