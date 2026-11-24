// 分段控件的指示块（#518，design/ui-system/visual-and-motion.md）：只有一个，停在选中的那一段上；选择变了才滑动，
// 第一次出现和尺寸变化直接到位。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "./Segmented";
import { resize } from "../test/platform";

const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙" },
  { value: "c", label: "丙" },
];

/** jsdom 不排版：给三段各 40 宽、依次排开。 */
function layOut() {
  const items = [...document.querySelectorAll<HTMLElement>(".k-seg-item")];
  items.forEach((item, i) => {
    Object.defineProperty(item, "offsetLeft", { configurable: true, value: 4 + i * 42 });
    Object.defineProperty(item, "offsetTop", { configurable: true, value: 4 });
    Object.defineProperty(item, "offsetWidth", { configurable: true, value: 40 });
    Object.defineProperty(item, "offsetHeight", { configurable: true, value: 28 });
  });
}

const thumb = () => document.querySelector<HTMLElement>(".k-seg-thumb")!;
const panel = (value: string | null, onChange: (value: string) => void = () => {}) => (
  <Segmented label="档位" value={value} options={OPTIONS} onChange={onChange} />
);

describe("分段控件的指示块", () => {
  it("没有选中时不出现；选中的那一段按下", () => {
    const view = render(panel(null));
    expect(thumb().hidden).toBe(true);
    view.rerender(panel("b"));
    expect(thumb().hidden).toBe(false);
    expect(screen.getByRole("button", { name: "乙" }).getAttribute("aria-pressed")).toBe("true");
    // 指示块不是一段：读屏和按键都碰不到它。
    expect(thumb().getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("第一次出现直接到位，换一段才滑过去，尺寸变了直接跟上", () => {
    const view = render(panel(null));
    layOut();
    view.rerender(panel("a"));
    expect(thumb().style.transition).toBe("none");
    expect(thumb().style.transform).toBe("translate(4px, 4px)");
    expect(thumb().style.width).toBe("40px");

    view.rerender(panel("c"));
    expect(thumb().style.transition).toBe("");
    expect(thumb().style.transform).toBe("translate(88px, 4px)");
  });

  it("点另一段报出新的值；再点已选的一段不报", () => {
    const picked: string[] = [];
    render(panel("a", (value) => picked.push(value)));
    fireEvent.click(screen.getByRole("button", { name: "乙" }));
    fireEvent.click(screen.getByRole("button", { name: "甲" }));
    expect(picked).toEqual(["b"]);
  });

  it("滑动结束后尺寸变化不再带动画", async () => {
    const view = render(panel("a"));
    layOut();
    view.rerender(panel("b"));
    expect(thumb().style.transition).toBe("");
    await new Promise((done) => setTimeout(done, 300));
    resize(document.querySelector(".k-seg")!);
    expect(thumb().style.transition).toBe("none");
  });
});
