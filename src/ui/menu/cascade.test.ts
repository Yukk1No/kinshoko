import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CascadeController } from "./cascade";
import { MENU_TIMING } from "./timing";

type Box = { left: number; top: number; right: number; bottom: number };
const place = (el: Element, b: Box) => {
  el.getBoundingClientRect = () => DOMRect.fromRect({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top });
};
const level = (depth: number, b: Box) => {
  const el = document.createElement("div");
  el.dataset.kLevel = String(depth);
  place(el, b);
  document.body.append(el);
  return el;
};
const row = (parent: HTMLElement, id: string, depth: number, kind: "folder" | "plain") => {
  const el = document.createElement("div");
  Object.assign(el.dataset, { kRow: id, kDepth: String(depth), kKind: kind });
  parent.append(el);
  return el;
};

/** 主菜单 0..200 宽；A、B 是文件夹行，C 是普通行；A 的子菜单在右侧 192..420。 */
function setup() {
  let now = 0;
  const ctrl = new CascadeController(() => now);
  const root = level(0, { left: 0, top: 0, right: 200, bottom: 300 });
  const a = row(root, "A", 0, "folder"), b = row(root, "B", 0, "folder"), c = row(root, "C", 0, "plain");
  ctrl.registerLevel(0, root);
  const move = (x: number, y: number, target: Element | null, opts?: { touch?: boolean; dragging?: boolean }) => ctrl.pointerMove({ x, y }, target, opts);
  const wait = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };
  const openA = () => {
    move(100, 20, a);
    wait(MENU_TIMING.openDelay);
    const sub = level(1, { left: 192, top: 10, right: 420, bottom: 200 });
    ctrl.registerLevel(1, sub);
    return sub;
  };
  return { ctrl, root, a, b, c, move, wait, openA, state: () => ctrl.getState() };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("悬停延时", () => {
  it("文件夹行悬停 220 ms 后才打开子菜单，行立刻高亮", () => {
    const t = setup();
    t.move(100, 20, t.a);
    expect(t.state().hover[0]).toBe("A");
    t.wait(MENU_TIMING.openDelay - 1);
    expect(t.state().open[0]).toBeUndefined();
    t.wait(1);
    expect(t.state().open[0]).toBe("A");
  });
  it("到时间之前离开这一行就取消", () => {
    const t = setup();
    t.move(100, 20, t.a);
    t.wait(100);
    t.move(100, 400, null);
    t.wait(MENU_TIMING.openDelay);
    expect(t.state().open[0]).toBeUndefined();
    expect(t.state().hover[0]).toBeNull();
  });
  it("普通行悬停 220 ms 后收起更深的子菜单", () => {
    const t = setup();
    t.openA();
    t.move(40, 95, t.c);
    t.move(40, 96, t.c);
    t.wait(MENU_TIMING.openDelay - 1);
    expect(t.state().open[0]).toBe("A");
    t.wait(1);
    expect(t.state().open[0]).toBeUndefined();
  });
  it("拖着东西悬停在文件夹行上要等 420 ms", () => {
    const t = setup();
    t.move(100, 20, t.a, { dragging: true });
    t.wait(MENU_TIMING.openDelay);
    expect(t.state().open[0]).toBeUndefined();
    t.wait(MENU_TIMING.dragOpenDelay - MENU_TIMING.openDelay);
    expect(t.state().open[0]).toBe("A");
  });
  it("触摸立刻生效", () => {
    const t = setup();
    t.move(100, 20, t.a, { touch: true });
    expect(t.state().open[0]).toBe("A");
  });
});

describe("安全区", () => {
  it("斜着朝子菜单移动时途经的行不高亮、不换子菜单", () => {
    const t = setup();
    t.openA();
    t.move(150, 30, t.a);
    t.move(170, 60, t.b);
    expect(t.state().hover[0]).toBe("A");
    expect(t.state().skipped).toBe("B");
    t.wait(MENU_TIMING.openDelay);
    expect(t.state().open[0]).toBe("A");
  });
  it("指针离开安全区后下一次重查就换过去", () => {
    const t = setup();
    t.openA();
    t.move(150, 30, t.a);
    t.move(170, 60, t.b);
    t.move(130, 62, t.b);
    expect(t.state().hover[0]).toBe("B");
    expect(t.state().open[0]).toBe("B");
  });
  it("指针停在安全区里，1200 ms 后仍换上新的子菜单", () => {
    const t = setup();
    t.openA();
    t.move(150, 30, t.a);
    t.move(170, 60, t.b);
    t.wait(MENU_TIMING.safeWindowMax - MENU_TIMING.safeRecheck);
    expect(t.state().open[0]).toBe("A");
    t.wait(MENU_TIMING.safeRecheck);
    expect(t.state().open[0]).toBe("B");
    expect(t.state().skipped).toBeNull();
  });
  it("指针进了子菜单，保护到此为止", () => {
    const t = setup();
    const sub = t.openA();
    t.move(150, 30, t.a);
    t.move(170, 60, t.b);
    t.move(200, 70, sub);
    expect(t.state().skipped).toBeNull();
    t.wait(MENU_TIMING.safeWindowMax);
    expect(t.state().open[0]).toBe("A");
    expect(t.state().hover[0]).toBe("A");
  });
});

describe("离开即关（按钮打开的菜单）", () => {
  const anchored = () => {
    const t = setup();
    const close = vi.fn();
    t.ctrl.closeAll = close;
    t.ctrl.anchor = document.createElement("button");
    place(t.ctrl.anchor, { left: 0, top: -40, right: 40, bottom: -4 });
    return { ...t, close };
  };
  it("离开触发按钮与所有层 360 ms 后整个关闭", () => {
    const t = anchored();
    t.move(100, 20, t.a);
    t.move(600, 600, null);
    t.wait(MENU_TIMING.closeDelay - 1);
    expect(t.close).not.toHaveBeenCalled();
    t.wait(1);
    expect(t.close).toHaveBeenCalledOnce();
  });
  it("及时回来就不关", () => {
    const t = anchored();
    t.move(100, 20, t.a);
    t.move(600, 600, null);
    t.wait(200);
    t.move(20, -20, null);
    t.wait(MENU_TIMING.closeDelay);
    expect(t.close).not.toHaveBeenCalled();
  });
  it("没有离开函数（右键菜单）时滑出不关", () => {
    const t = setup();
    t.move(100, 20, t.a);
    t.move(600, 600, null);
    t.wait(MENU_TIMING.closeDelay);
    expect(t.state().hover[0]).toBeNull();
  });
});

describe("键盘与 Base UI 的开合", () => {
  it("键盘打开、收起子菜单照办，并切到键盘高亮", () => {
    const t = setup();
    t.ctrl.requestOpen(0, "A", true, "list-navigation");
    expect(t.state().open[0]).toBe("A");
    expect(t.state().input).toBe("keyboard");
    t.ctrl.requestOpen(0, "A", false, "list-navigation");
    expect(t.state().open[0]).toBeUndefined();
  });
  it("指针相关的开合原因不听", () => {
    const t = setup();
    t.ctrl.requestOpen(0, "A", true, "list-navigation");
    t.ctrl.requestOpen(0, "A", false, "focus-out");
    t.ctrl.requestOpen(0, "A", false, "sibling-open");
    expect(t.state().open[0]).toBe("A");
  });
  it("收起一层时更深的层一起收起", () => {
    const t = setup();
    t.ctrl.requestOpen(0, "A", true, "trigger-press");
    t.ctrl.requestOpen(1, "A1", true, "trigger-press");
    t.ctrl.requestOpen(0, "A", false, "escape-key");
    expect(t.state().open).toEqual([]);
  });
});
