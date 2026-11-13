import { Profiler } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DensitySlider } from "./DensitySlider";

afterEach(cleanup);

/** 每次提交都记下滑块当时的值：属性变了以后，第一次提交里就不能还是旧值（#544）。 */
function renderSlider(value: number, preview: number | null = null) {
  const seen: string[] = [];
  const slider = (v: number, p: number | null) => <Profiler id="slider" onRender={() => seen.push((screen.getByRole("slider") as HTMLInputElement).value)}>
    <DensitySlider value={v} preview={p} label="大小" onPreview={() => {}} onCommit={() => {}} />
  </Profiler>;
  const view = render(slider(value, preview));
  return { seen, rerender: (v: number, p: number | null = null) => view.rerender(slider(v, p)) };
}

const value = () => (screen.getByRole("slider") as HTMLInputElement).value;

describe("DensitySlider 跟着属性", () => {
  it("value 变了，同一次提交里滑块就在新位置", () => {
    const { seen, rerender } = renderSlider(240);
    seen.length = 0;
    rerender(300);
    expect(value()).toBe("300");
    expect(seen).toEqual(["300"]);
  });

  it("预览值变了跟着预览值，预览结束回到 value", () => {
    const { seen, rerender } = renderSlider(240);
    seen.length = 0;
    rerender(240, 320);
    expect(seen).toEqual(["320"]);
    seen.length = 0;
    rerender(240, null);
    expect(seen).toEqual(["240"]);
  });

  it("一开始就有预览值时显示预览值", () => {
    renderSlider(240, 360);
    expect(value()).toBe("360");
  });
});
