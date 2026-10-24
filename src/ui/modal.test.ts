import { afterEach, expect, it } from "vitest";
import { modalOpen } from "./modal";

afterEach(() => { document.body.innerHTML = ""; });

it("行内浮层（role=dialog 但不模态）不算打开了模态", () => {
  document.body.innerHTML = '<div class="search-popover" role="dialog" aria-label="加相近标签"></div><div role="dialog" aria-label="“蓝发”的别名"></div>';
  expect(modalOpen()).toBe(false);
});

it.each([
  ['<section role="dialog" aria-modal="true" aria-label="确认"></section>'],
  ['<div role="alertdialog" aria-label="永久删除"></div>'],
  ['<div class="k-dialog" role="dialog" data-open=""></div>'],
])("真正的模态算打开：%s", (markup) => {
  document.body.innerHTML = markup;
  expect(modalOpen()).toBe(true);
});

it("关闭中的对话框（没有 data-open）不算", () => {
  document.body.innerHTML = '<div class="k-dialog" role="dialog" hidden></div>';
  expect(modalOpen()).toBe(false);
});
