// 侧栏开合：自身 width 过渡开始到结束之间给出墙宽的变化量与过渡节奏，结束后为 null。
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { usePanelSlide, type PanelSlide } from "./usePanelSlide";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

let seen: PanelSlide | null = null;
function Panel({ final }: { final: number | null }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  seen = usePanelSlide(element, final);
  return <aside ref={setElement} style={{ transitionProperty: "width", transitionDuration: "0.26s", transitionTimingFunction: "ease-out" }}><button type="button">收起</button></aside>;
}

const fire = (target: Element, type: string, propertyName = "width") =>
  act(() => { target.dispatchEvent(new TransitionEvent(type, { propertyName, bubbles: true })); });
const panelAt = (width: number) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 800));

it("过渡开始时给出墙宽变化量（面板现在的宽度减终点）与过渡节奏，结束后为 null", () => {
  panelAt(256);
  const { container } = render(<Panel final={0} />);
  const panel = container.querySelector("aside")!;
  expect(seen).toBeNull();
  fire(panel, "transitionrun");
  expect(seen).toMatchObject({ by: 256, duration: 260, easing: "ease-out" });
  fire(panel, "transitionend");
  expect(seen).toBeNull();
});

it("能读到面板的 CSS 过渡时，节奏与起点取自它", () => {
  panelAt(0);
  const transition = { transitionProperty: "width", startTime: 500, effect: { getTiming: () => ({ duration: 300, easing: "linear" }) } };
  (HTMLElement.prototype as { getAnimations?: () => unknown[] }).getAnimations = () => [transition];
  try {
    const { container } = render(<Panel final={256} />);
    fire(container.querySelector("aside")!, "transitionrun");
    expect(seen).toEqual({ by: -256, duration: 300, easing: "linear", startTime: 500 });
  } finally {
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
  }
});

it("中途反向：按新的过渡重新算，旧的取消不提前结束", () => {
  const rect = panelAt(256);
  const { container, rerender } = render(<Panel final={0} />);
  const panel = container.querySelector("aside")!;
  fire(panel, "transitionrun");
  rect.mockReturnValue(new DOMRect(0, 0, 100, 800));
  // 反向时新的终点由重新渲染给出。
  rerender(<Panel final={256} />);
  fire(panel, "transitionrun");
  fire(panel, "transitioncancel");
  expect(seen).toMatchObject({ by: -156 });
  fire(panel, "transitionend");
  expect(seen).toBeNull();
});

it("面板不占墙的宽度（浮起）时仍不给出变化量；其他元素和属性的过渡不算", () => {
  panelAt(256);
  const { container } = render(<Panel final={null} />);
  const panel = container.querySelector("aside")!;
  fire(panel, "transitionrun");
  expect(seen).toBeNull();
  fire(panel, "transitionend");
  fire(panel.querySelector("button")!, "transitionrun");
  fire(panel, "transitionrun", "border-right-width");
  expect(seen).toBeNull();
});
