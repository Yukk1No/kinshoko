import { afterEach, beforeEach, expect, it } from "vitest";
import { blockBrowserMenu } from "./browserMenu";

let stop: () => void;
beforeEach(() => { stop = blockBrowserMenu(window); });
afterEach(() => { stop(); document.body.innerHTML = ""; });

const rightClick = (node: Element) => {
  const e = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  node.dispatchEvent(e);
  return e.defaultPrevented;
};

it("侧栏、导航栏这类没有自己菜单的地方右键，不弹浏览器菜单（#229）", () => {
  document.body.innerHTML = '<nav><button type="button">参考组</button></nav><aside><p>详情</p></aside>';
  expect(rightClick(document.querySelector("button")!)).toBe(true);
  expect(rightClick(document.querySelector("p")!)).toBe(true);
  expect(rightClick(document.body)).toBe(true);
});

it("子元素拦住冒泡也不弹（钉图里的运行环境提示 stopPropagation）", () => {
  document.body.innerHTML = '<div class="pin-runtime-problem"><p>提示</p></div>';
  document.querySelector("div")!.addEventListener("contextmenu", (e) => e.stopPropagation());
  expect(rightClick(document.querySelector("p")!)).toBe(true);
});

it.each([
  ['<input type="search" />', "input"],
  ['<input />', "input"],
  ["<textarea></textarea>", "textarea"],
  ['<div contenteditable="true"><span>名字</span></div>', "span"],
])("能输入文字的地方保留系统的剪切、复制、粘贴菜单：%s", (markup, selector) => {
  document.body.innerHTML = markup;
  expect(rightClick(document.querySelector(selector)!)).toBe(false);
});

it.each([
  ['<input disabled />', "input"],
  ["<textarea disabled></textarea>", "textarea"],
  ["<fieldset disabled><input /></fieldset>", "input"],
])("被禁用的输入框不放行：%s", (markup, selector) => {
  document.body.innerHTML = markup;
  expect(rightClick(document.querySelector(selector)!)).toBe(true);
});

it("复选框等不能输入文字的 input 不算", () => {
  document.body.innerHTML = '<input type="checkbox" />';
  expect(rightClick(document.querySelector("input")!)).toBe(true);
});

it("撤销后恢复浏览器的默认行为", () => {
  stop();
  document.body.innerHTML = "<p>详情</p>";
  expect(rightClick(document.querySelector("p")!)).toBe(false);
  stop = () => {};
});
