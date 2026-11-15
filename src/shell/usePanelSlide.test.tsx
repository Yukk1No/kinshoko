// 侧栏与详情面板开合：任一面板 width 过渡开始到全部结束之间给出墙宽的变化量与过渡节奏，结束后为 null。
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { usePanelSlide, type PanelSlide } from "./usePanelSlide";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let seen: PanelSlide | null = null;
function Panel({ final }: { final: number | null }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  seen = usePanelSlide([{ element, finalWidth: final }]);
  return (
    <aside
      ref={setElement}
      style={{ transitionProperty: "width", transitionDuration: "0.26s", transitionTimingFunction: "ease-out" }}
    >
      <button type="button">收起</button>
    </aside>
  );
}

const fire = (target: Element, type: string, propertyName = "width") =>
  act(() => {
    target.dispatchEvent(new TransitionEvent(type, { propertyName, bubbles: true }));
  });
const panelAt = (width: number) =>
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 800));

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
  const transition = {
    transitionProperty: "width",
    startTime: 500,
    effect: { getTiming: () => ({ duration: 300, easing: "linear" }) },
  };
  const animations = vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([transition as unknown as Animation]);
  try {
    const { container } = render(<Panel final={256} />);
    fire(container.querySelector("aside")!, "transitionrun");
    expect(seen).toEqual({ by: -256, duration: 300, easing: "linear", startTime: 500 });
  } finally {
    animations.mockRestore();
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

it("中途反向时取消先到（新过渡已存在）：slide 不断，直到新过渡结束", () => {
  const rect = panelAt(256);
  const { container, rerender } = render(<Panel final={0} />);
  const panel = container.querySelector("aside")!;
  fire(panel, "transitionrun");
  const first = seen;
  rect.mockReturnValue(new DOMRect(0, 0, 100, 800));
  rerender(<Panel final={256} />);
  const transition = {
    transitionProperty: "width",
    startTime: null,
    effect: { getTiming: () => ({ duration: 120, easing: "linear" }) },
  };
  const animations = vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([transition as unknown as Animation]);
  try {
    fire(panel, "transitioncancel");
    expect(seen).toBe(first);
    fire(panel, "transitionrun");
    expect(seen).toEqual({ by: -156, duration: 120, easing: "linear", startTime: null });
    animations.mockReturnValue([]);
    fire(panel, "transitionend");
    expect(seen).toBeNull();
  } finally {
    animations.mockRestore();
  }
});

it("取消后没有新过渡（开始拖动打断）：slide 随即结束", () => {
  panelAt(256);
  const { container } = render(<Panel final={0} />);
  const panel = container.querySelector("aside")!;
  fire(panel, "transitionrun");
  fire(panel, "transitioncancel");
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

function Both({ sidebar = 200, inspector = 320 }: { sidebar?: number | null; inspector?: number }) {
  const [sidebarElement, setSidebar] = useState<HTMLElement | null>(null);
  const [inspectorElement, setInspector] = useState<HTMLElement | null>(null);
  seen = usePanelSlide([
    { element: sidebarElement, finalWidth: sidebar },
    { element: inspectorElement, finalWidth: inspector },
  ]);
  return (
    <>
      <aside ref={setSidebar} />
      <section ref={setInspector} />
    </>
  );
}
const widths = (aside: number, section: number) =>
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.tagName === "SECTION" ? section : aside, 800);
  });

it("另一侧的面板同时变宽变窄时，它的变化量一并算进墙宽，哪一边先开始都一样", () => {
  widths(256, 0);
  const { container } = render(<Both />);
  // 侧栏 256 → 200 让出 56，详情 0 → 320 占去 320：墙最终窄 264。
  fire(container.querySelector("aside")!, "transitionrun");
  expect(seen).toMatchObject({ by: -264 });
  cleanup();
  const again = render(<Both />);
  fire(again.container.querySelector("section")!, "transitionrun");
  expect(seen).toMatchObject({ by: -264 });
});

it("两个面板一起滑：一个先结束时 slide 不变，全部结束才为 null", () => {
  widths(256, 0);
  const { container } = render(<Both />);
  const aside = container.querySelector("aside")!,
    section = container.querySelector("section")!;
  fire(aside, "transitionrun");
  fire(section, "transitionrun");
  const during = seen;
  fire(section, "transitionend");
  expect(seen).toBe(during);
  fire(aside, "transitionend");
  expect(seen).toBeNull();
});

it("浮起的侧栏自己的过渡不算，详情面板开合时也不算进它的宽度", () => {
  widths(256, 320);
  const { container } = render(<Both sidebar={null} inspector={0} />);
  fire(container.querySelector("aside")!, "transitionrun");
  expect(seen).toBeNull();
  fire(container.querySelector("section")!, "transitionrun");
  expect(seen).toMatchObject({ by: 320 });
});
