import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("一挂上就是打开的对话框（父组件按条件挂载）", () => {
  let frames: { el: Element; keyframes: Keyframe[]; finish: () => void }[];
  beforeEach(() => {
    frames = [];
    for (const [name, value] of Object.entries({
      "--t": "200ms",
      "--t-fast": "120ms",
      "--t-slow": "320ms",
      "--t-pop": "220ms",
    }))
      document.documentElement.style.setProperty(name, value);
    HTMLElement.prototype.animate = function (this: Element, keyframes: Keyframe[]) {
      let finish = () => {};
      const finished = new Promise((resolve) => {
        finish = () => resolve(undefined);
      });
      frames.push({ el: this, keyframes, finish });
      return { finished } as unknown as Animation;
    } as unknown as typeof HTMLElement.prototype.animate;
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    document.documentElement.removeAttribute("style");
  });

  function backdrop() {
    const b = document.createElement("div");
    b.className = "k-backdrop";
    return b;
  }
  const ghosts = (selector: string) => document.querySelectorAll(`${selector}.is-k-ghost`);

  it("遮罩跟着淡入，卸下后留一个副本淡出再拿掉", async () => {
    const root = document.createElement("div");
    root.append(backdrop(), dialog());
    document.body.append(root);
    await flush();
    const dimIn = frames.find((f) => (f.el as HTMLElement).matches(".k-backdrop"));
    expect(dimIn?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);

    root.remove();
    await flush();
    expect(ghosts(".k-backdrop")).toHaveLength(1);
    const dimOut = frames.find((f) => (f.el as HTMLElement).matches(".k-backdrop.is-k-ghost"));
    expect(dimOut?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    // 副本不能挡住点击，也不让读屏读到。
    const ghost = ghosts(".k-backdrop")[0] as HTMLElement;
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    for (const f of frames) f.finish();
    await flush();
    expect(ghosts(".k-backdrop")).toHaveLength(0);
  });

  it("认不出按钮时从中间轻微放大出现，卸下时在中间缩小淡出", async () => {
    const d = dialog();
    document.body.append(d);
    await flush();
    expect(d.dataset.kFrom).toBeUndefined();
    expect(frames.find((f) => f.el === d)?.keyframes).toEqual([
      { transform: "scale(0.97)" },
      { transform: "scale(1)" },
    ]);

    d.remove();
    await flush();
    const ghost = ghosts(".k-dialog")[0] as HTMLElement;
    expect(ghost).toBeDefined();
    expect(ghost.style.transformOrigin).toBe("");
    expect(frames.find((f) => f.el === ghost)?.keyframes).toEqual([
      { transform: "scale(1)" },
      { transform: "scale(0.97)" },
    ]);
  });

  it("走了 Base UI 起止态的遮罩与对话框不再补动画", async () => {
    const b = backdrop();
    const d = dialog();
    b.setAttribute("data-starting-style", "");
    d.setAttribute("data-starting-style", "");
    document.body.append(b, d);
    await flush();
    expect(frames).toHaveLength(0);

    b.setAttribute("data-ending-style", "");
    d.setAttribute("data-ending-style", "");
    await flush();
    b.remove();
    d.remove();
    await flush();
    expect(frames).toHaveLength(0);
    expect(document.querySelectorAll(".is-k-ghost")).toHaveLength(0);
  });
});
