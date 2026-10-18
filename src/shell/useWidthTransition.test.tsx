// #162：详情面板自己的宽度过渡从开始到结束都算“宽度未稳定”，图片墙在这段时间里不重排。
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { useWidthTransition } from "./useWidthTransition";

afterEach(cleanup);

function Panel() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const moving = useWidthTransition(element);
  return <aside ref={setElement} data-moving={moving}><button type="button">收起</button></aside>;
}

const fire = (target: Element, type: string, propertyName = "width") =>
  act(() => { target.dispatchEvent(new TransitionEvent(type, { propertyName, bubbles: true })); });

it("面板宽度过渡开始到结束之间为真", () => {
  const { container } = render(<Panel />);
  const panel = container.querySelector("aside")!;
  expect(panel.dataset.moving).toBe("false");
  fire(panel, "transitionrun");
  expect(panel.dataset.moving).toBe("true");
  fire(panel, "transitionend");
  expect(panel.dataset.moving).toBe("false");
});

it("过渡中途反向（先取消旧的、再开始新的，或反过来）仍算在过渡中，直到新的结束", () => {
  const { container } = render(<Panel />);
  const panel = container.querySelector("aside")!;
  fire(panel, "transitionrun");
  fire(panel, "transitioncancel");
  fire(panel, "transitionrun");
  expect(panel.dataset.moving).toBe("true");
  fire(panel, "transitionrun");
  fire(panel, "transitioncancel");
  expect(panel.dataset.moving).toBe("true");
  fire(panel, "transitionend");
  expect(panel.dataset.moving).toBe("false");
});

it("面板里其他元素的过渡和面板的其他属性不算", () => {
  const { container } = render(<Panel />);
  const panel = container.querySelector("aside")!;
  fire(panel.querySelector("button")!, "transitionrun");
  fire(panel, "transitionrun", "border-left-width");
  expect(panel.dataset.moving).toBe("false");
});

it("过渡开始与结束在事件里同步生效，不等到同一帧的尺寸观察之后", () => {
  const { container } = render(<Panel />);
  const panel = container.querySelector("aside")!;
  // 浏览器先派发过渡事件，再在同一帧里报告尺寸变化；不经 act，看事件返回时是否已经生效。
  panel.dispatchEvent(new TransitionEvent("transitionrun", { propertyName: "width" }));
  expect(panel.dataset.moving).toBe("true");
  panel.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "width" }));
  expect(panel.dataset.moving).toBe("false");
});
