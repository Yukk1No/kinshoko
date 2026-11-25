import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogOrigin } from "./dialogOrigin";

let uninstall: () => void;
let now = 0;

function place(el: HTMLElement, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: height });
}

function button(label: string, left: number, top: number) {
  const b = document.createElement("button");
  b.textContent = label;
  place(b, left, top, 20, 20);
  document.body.append(b);
  return b;
}

/** 对话框 400 × 300，居中在 (500, 400)：左上角 (300, 250)。 */
function dialog() {
  const d = document.createElement("div");
  d.className = "k-dialog";
  d.setAttribute("role", "dialog");
  place(d, 300, 250, 400, 300);
  return d;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  now = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  uninstall = installDialogOrigin(window);
});
afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("点按钮打开的对话框从按钮中心长出来", async () => {
  const b = button("导入", 890, 10);
  b.click();
  const d = dialog();
  document.body.append(d);
  await flush();
  expect(d.dataset.kFrom).toBe("trigger");
  // 按钮中心 (900, 20) 减左上角 (300, 250)。
  expect(d.style.transformOrigin).toBe("600px -230px");
});

it("没点按钮（快捷键、自动弹出）打开的对话框保持从中间出现", async () => {
  const b = button("导入", 890, 10);
  b.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true }));
  const d = dialog();
  document.body.append(d);
  await flush();
  expect(d.dataset.kFrom).toBeUndefined();
  expect(d.style.transformOrigin).toBe("");
});

it("隔久了只在焦点还停在按钮上时才认", async () => {
  const b = button("导入", 890, 10);
  const other = button("别的", 10, 10);
  b.focus();
  b.click();
  now += 5000;
  const held = dialog();
  document.body.append(held);
  await flush();
  expect(held.dataset.kFrom).toBe("trigger");
  held.remove();

  b.click();
  other.focus();
  now += 5000;
  const stale = dialog();
  document.body.append(stale);
  await flush();
  expect(stale.dataset.kFrom).toBeUndefined();
});

it("点菜单项、菜单关上后焦点回到菜单按钮：之后的对话框从菜单按钮长出来", async () => {
  const trigger = button("导入", 890, 10);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const item = document.createElement("div");
  item.setAttribute("role", "menuitem");
  place(item, 700, 60, 200, 32);
  menu.append(item);
  document.body.append(menu);
  item.click();
  menu.remove();
  trigger.focus();
  now += 8000; // 选文件用了几秒
  const d = dialog();
  document.body.append(d);
  await flush();
  expect(d.style.transformOrigin).toBe("600px -230px");
});

it("关上时按按钮此刻的位置重新算", async () => {
  const b = button("导入", 890, 10);
  b.click();
  const d = dialog();
  document.body.append(d);
  await flush();
  place(b, 90, 10, 20, 20);
  d.setAttribute("data-ending-style", "");
  await flush();
  expect(d.style.transformOrigin).toBe("-200px -230px");
});

it("按钮不在了就缩回打开时的位置", async () => {
  const b = button("导入", 890, 10);
  b.click();
  const d = dialog();
  document.body.append(d);
  await flush();
  b.remove();
  d.setAttribute("data-ending-style", "");
  await flush();
  expect(d.style.transformOrigin).toBe("600px -230px");
});
