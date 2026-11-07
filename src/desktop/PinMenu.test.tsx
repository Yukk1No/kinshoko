import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinMenu } from "../bindings/PinMenu";
import type { PinMenuOpen } from "../bindings/PinMenuOpen";
import type { PinNotice } from "../bindings/PinNotice";
import { i18n } from "../i18n/instance";

// 钉图的统一样式菜单（#102 T5，#106）。菜单窗口的放置与焦点在正式程序上核对；这里测菜单项与动作。
const ipc = vi.hoisted(() => ({
  first: null as PinMenuOpen | null,
  next: null as ((open: PinMenuOpen) => void) | null,
  shown: vi.fn((_generation: number) => Promise.resolve()),
  close: vi.fn((_generation: number) => Promise.resolve()),
  action: vi.fn((_pin: string, _action: string, _generation: number) => Promise.resolve(null as PinNotice | null)),
  notice: vi.fn((_pin: string, _text: string) => Promise.resolve()),
  groups: vi.fn(() => Promise.resolve([
    { id: "g1", name: "光影", memberCount: 2, libraryIds: ["L1"], updatedAt: 0, problem: null },
    { id: "g2", name: "坏的", memberCount: 0, libraryIds: [], updatedAt: 0, problem: { code: "groupInvalid" as const, cause: { code: "notAGroup" as const } } },
  ])),
}));
vi.mock("../ipc", () => ({
  desktopMenu: () => Promise.resolve(ipc.first),
  onDesktopMenu: (handler: (open: PinMenuOpen) => void) => { ipc.next = handler; return Promise.resolve(() => {}); },
  desktopMenuShown: ipc.shown,
  closeDesktopMenu: ipc.close,
  pinMenuAction: ipc.action,
  showPinNotice: ipc.notice,
  referenceGroups: ipc.groups,
}));

import { DesktopMenuView, menuAnchor, PinMenuItems } from "./PinMenu";
import { Menu } from "../ui/Menu";

afterEach(() => { cleanup(); vi.clearAllMocks(); ipc.first = null; ipc.next = null; });

const capture: PinMenu = {
  pin: "P1", capture: true, opacity: 70, locked: false, actualSize: false, veiled: false, canCollect: true, group: null,
  confirmReveal: false,
};
const reference: PinMenu = {
  pin: "P2", capture: false, opacity: 100, locked: false, actualSize: true, veiled: true, canCollect: false, group: "光影",
  confirmReveal: false,
};

function show(menu: PinMenu) {
  const act = vi.fn();
  render(<Menu.Root open><Menu.Portal><Menu.Positioner><Menu.Popup aria-label="钉图菜单">
    <PinMenuItems menu={menu} act={act} groups={ipc.groups} />
  </Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>);
  const popup = screen.getByRole("menu", { name: "钉图菜单" });
  const rows = () => [...popup.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map((row) => row.textContent);
  return { act, popup, rows };
}

describe("钉图菜单项", () => {
  it("截图钉图：保留原生菜单全部项，再加在 Kinshoko 中打开、加入参考组、贴边隐藏与关闭钉图", () => {
    const { rows, popup } = show(capture);
    expect(rows()).toEqual([
      "水平翻转H", "垂直翻转V", "顺时针旋转 90°R", "逆时针旋转 90°Shift R",
      "原始大小（100%）", "透明度70%", "锁定位置与大小",
      "收藏到…", "复制",
      "在 Kinshoko 中打开", "加入参考组", "贴边隐藏",
      "关闭钉图Esc",
    ]);
    expect(within(popup).getAllByRole("separator")).toHaveLength(4);
  });

  it("资料库钉图：没有收藏；遮蔽时有“显示这张图”、复制不可用，来自参考组时有“存回参考组”", () => {
    const { rows } = show(reference);
    expect(rows()).toEqual([
      "水平翻转H", "垂直翻转V", "顺时针旋转 90°R", "逆时针旋转 90°Shift R",
      "原始大小（100%）", "透明度100%", "锁定位置与大小",
      "复制", "显示这张图（安全模式下已遮蔽）", "存回参考组「光影」",
      "在 Kinshoko 中打开", "加入参考组", "贴边隐藏",
      "关闭钉图Esc",
    ]);
  });

  it("资料库钉图没有遮蔽也不来自参考组时，中间那一段只有能用的“复制”（#289）", () => {
    const { rows, popup, act } = show({ ...reference, veiled: false, group: null });
    expect(rows()).not.toContain("显示这张图（安全模式下已遮蔽）");
    expect(within(popup).getAllByRole("separator")).toHaveLength(4);
    const copy = screen.getByRole("menuitem", { name: "复制" });
    expect(copy.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(copy);
    expect(act).toHaveBeenCalledWith("copy");
  });

  it("被遮蔽的资料库钉图不能复制", () => {
    show(reference);
    expect(screen.getByRole("menuitem", { name: "复制" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("点了小圆锁：只问“显示这张图？”，显示即 reveal，取消只关菜单", () => {
    const dismiss = vi.fn();
    const act = vi.fn();
    render(<Menu.Root open><Menu.Portal><Menu.Positioner><Menu.Popup aria-label="钉图菜单">
      <PinMenuItems menu={{ ...reference, confirmReveal: true }} act={act} dismiss={dismiss} groups={ipc.groups} />
    </Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>);
    expect(screen.getByText("显示这张图？")).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((r) => r.textContent)).toEqual(["显示", "取消"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "取消" }));
    expect(dismiss).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "显示" }));
    expect(act).toHaveBeenCalledWith("reveal");
  });

  it("各项调用对应的动作", () => {
    const { act } = show(capture);
    const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("menuitem", { name }));
    click(/水平翻转/); click(/垂直翻转/); click(/顺时针/); click(/逆时针/);
    click("原始大小（100%）"); fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "锁定位置与大小" }));
    click("收藏到…"); click("复制");
    click("在 Kinshoko 中打开"); click("贴边隐藏"); click(/关闭钉图/);
    expect(act.mock.calls.map(([a]) => a)).toEqual([
      "flipH", "flipV", "rotateCw", "rotateCcw", "actualSize", "lock", "collect", "copy", "openInKinshoko", "edgeHide", "close",
    ]);
  });

  it("锁定时与已是原始大小时，“原始大小”不可用；锁定项打勾", () => {
    show({ ...capture, locked: true });
    expect(screen.getByRole("menuitem", { name: "原始大小（100%）" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitemcheckbox", { name: "锁定位置与大小" }).getAttribute("aria-checked")).toBe("true");
    cleanup();
    show(reference);
    expect(screen.getByRole("menuitem", { name: "原始大小（100%）" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("还没有图库时收藏不可用，并说明原因", () => {
    show({ ...capture, canCollect: false });
    expect(screen.getByRole("menuitem", { name: "收藏（还没有图库）" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("透明度子菜单：当前一档打勾，选中一档改透明度", async () => {
    const { act } = show(capture);
    fireEvent.click(screen.getByRole("menuitem", { name: /透明度/ }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["100%", "90%", "80%", "70%", "60%", "50%", "40%", "30%", "20%", "10%"]);
    expect(screen.getByRole("menuitemradio", { name: "70%" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "40%" }));
    expect(act).toHaveBeenCalledWith("opacity:40");
  });

  it("加入参考组：资料库钉图列出可用的参考组；截图钉图说明要先收藏", async () => {
    const { act } = show(reference);
    fireEvent.click(screen.getByRole("menuitem", { name: "加入参考组" }));
    const group = await screen.findByRole("menuitem", { name: "光影" });
    expect(screen.queryByRole("menuitem", { name: "坏的" })).toBeNull();
    fireEvent.click(group);
    expect(act).toHaveBeenCalledWith("group:g1");
    cleanup();
    show(capture);
    fireEvent.click(screen.getByRole("menuitem", { name: "加入参考组" }));
    expect(await screen.findByText("截图要先收藏进图库，才能加入参考组")).toBeTruthy();
    expect(ipc.groups).toHaveBeenCalledTimes(1);
  });
});

describe("菜单窗口", () => {
  const open = (generation: number, menu: PinMenu = capture): PinMenuOpen => ({
    generation, menu, surface: { window: { x: -1920, y: 0, width: 1920, height: 1080 }, x: 300, y: 150 },
  });
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

  it("锚点按页面的缩放比例从物理像素换算成 CSS 像素", () => {
    expect(menuAnchor(open(1), 1.5)).toEqual({ x: 200, y: 100 });
    expect(menuAnchor(open(1), 1.25)).toEqual({ x: 240, y: 120 });
    expect(menuAnchor(open(1), 0)).toEqual({ x: 300, y: 150 });
  });

  it("窗口建好时取到待显示的菜单，画好后请应用壳显示窗口", async () => {
    ipc.first = open(3);
    render(<DesktopMenuView />);
    await settle();
    expect(await screen.findByRole("menu", { name: "钉图菜单" })).toBeTruthy();
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(ipc.shown).toHaveBeenCalledWith(3);
  });

  it("选中一项：把动作连同这次菜单的编号交给应用壳，不再另外关闭", async () => {
    render(<DesktopMenuView />);
    await settle();
    act(() => ipc.next!(open(4)));
    fireEvent.click(await screen.findByRole("menuitem", { name: /水平翻转/ }));
    await settle();
    expect(ipc.action).toHaveBeenCalledWith("P1", "flipH", 4);
    expect(ipc.close).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "钉图菜单" })).toBeNull();
  });

  it("做完一项后按界面语言写好提示，交回钉图显示", async () => {
    render(<DesktopMenuView />);
    await settle();
    ipc.action.mockResolvedValueOnce({ kind: "addedToGroup", name: "光影" });
    act(() => ipc.next!(open(6)));
    fireEvent.click(await screen.findByRole("menuitem", { name: /水平翻转/ }));
    await settle();
    expect(ipc.notice).toHaveBeenCalledWith("P1", "已加入参考组「光影」");

    await i18n.changeLanguage("en");
    try {
      ipc.action.mockResolvedValueOnce({ kind: "failed", error: { code: "pinLocked" } });
      act(() => ipc.next!(open(7)));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Flip horizontally/ }));
      await settle();
      expect(ipc.notice).toHaveBeenLastCalledWith("P1", "The pin is locked");
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("Esc、点外部或窗口失去焦点都关闭菜单，同一次只关一回", async () => {
    render(<DesktopMenuView />);
    await settle();
    act(() => ipc.next!(open(5)));
    const menu = await screen.findByRole("menu", { name: "钉图菜单" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    expect(ipc.close).toHaveBeenCalledWith(5);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(ipc.close).toHaveBeenCalledTimes(1);

    act(() => ipc.next!(open(6)));
    await screen.findByRole("menu", { name: "钉图菜单" });
    fireEvent.pointerDown(document.querySelector(".desktop-menu-backdrop")!);
    await settle();
    expect(ipc.close).toHaveBeenLastCalledWith(6);

    act(() => ipc.next!(open(7)));
    await screen.findByRole("menu", { name: "钉图菜单" });
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(ipc.close).toHaveBeenLastCalledWith(7);
    expect(ipc.close).toHaveBeenCalledTimes(3);
  });

  it("悬停在带子菜单的项上：展开子菜单，主菜单不关（#309）", async () => {
    render(<DesktopMenuView />);
    await settle();
    act(() => ipc.next!(open(10, reference)));
    for (const name of [/透明度/, "加入参考组"]) {
      const trigger = await screen.findByRole("menuitem", { name });
      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      fireEvent.mouseEnter(trigger);
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      fireEvent.mouseMove(trigger);
      await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
      await settle();
      expect(screen.queryByRole("menu", { name: "钉图菜单" })).toBeTruthy();
      expect(ipc.close).not.toHaveBeenCalled();
    }
    expect(await screen.findByRole("menu", { name: "加入参考组" })).toBeTruthy();
  });

  it("从触发项移进子菜单再选一档：子菜单与主菜单都不收（#309）", async () => {
    // 触发项在左，子菜单贴在它右边；jsdom 没有布局，按真实摆放给出矩形，让悬停的安全区按几何判断。
    const rect = (x: number, y: number, w: number, h: number) => DOMRect.fromRect({ x, y, width: w, height: h });
    const boxes = new Map<Element, DOMRect>();
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      for (const [el, box] of boxes) if (el === this || (el.parentElement === this && this.classList.contains("k-positioner"))) return box;
      return rect(0, 0, 0, 0);
    });
    try {
      render(<DesktopMenuView />);
      await settle();
      act(() => ipc.next!(open(11, reference)));
      const trigger = await screen.findByRole("menuitem", { name: /透明度/ });
      boxes.set(trigger, rect(0, 100, 200, 30));
      const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
      const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerType: "mouse" as const });
      fireEvent.pointerEnter(trigger, at(100, 115));
      fireEvent.mouseEnter(trigger, at(100, 115));
      fireEvent.pointerMove(trigger, at(150, 115));
      fireEvent.mouseMove(trigger, at(150, 115));
      await wait(150);
      const sub = await screen.findByRole("menu", { name: /^透明度/ });
      boxes.set(sub, rect(202, 100, 120, 300));
      const backdrop = document.querySelector(".desktop-menu-backdrop")!;
      fireEvent.pointerLeave(trigger, { ...at(201, 116), relatedTarget: backdrop });
      fireEvent.mouseLeave(trigger, { ...at(201, 116), relatedTarget: backdrop });
      fireEvent.mouseMove(backdrop, at(202, 118));
      const item = within(sub).getByRole("menuitemradio", { name: "40%" });
      boxes.set(item, rect(202, 250, 120, 28));
      for (const target of [sub, item]) {
        fireEvent.pointerEnter(target, at(220, 260));
        fireEvent.mouseEnter(target, at(220, 260));
        fireEvent.pointerMove(target, at(220, 262));
        fireEvent.mouseMove(target, at(220, 262));
      }
      await wait(300);
      expect(screen.getByRole("menu", { name: "钉图菜单" })).toBeTruthy();
      expect(screen.getByRole("menu", { name: /^透明度/ })).toBeTruthy();
      fireEvent.click(within(sub).getByRole("menuitemradio", { name: "40%" }));
      await settle();
      expect(ipc.action).toHaveBeenCalledWith("P2", "opacity:40", 11);
      expect(ipc.close).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("又右键了别的钉图：换成新的菜单", async () => {
    render(<DesktopMenuView />);
    await settle();
    act(() => ipc.next!(open(8)));
    await screen.findByRole("menuitem", { name: "收藏到…" });
    act(() => ipc.next!(open(9, reference)));
    expect(await screen.findByRole("menuitem", { name: "存回参考组「光影」" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /关闭钉图/ }));
    expect(ipc.action).toHaveBeenCalledWith("P2", "close", 9);
  });
});
