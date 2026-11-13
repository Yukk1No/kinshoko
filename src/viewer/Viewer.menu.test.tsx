import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { Viewer } from "./Viewer";

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { events.set(name, callback); return () => events.delete(name); }) }));

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  mockConvertFileSrc("windows");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("查看器右键菜单（#114）", () => {
  const card = { id: "a", width: 800, height: 600, thumbnail: "", adult: false };
  let backend: FakeBackend;
  let fail: string | null;
  beforeEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    fail = null;
    /** 桌面命令（复制、显示、钉住）答 void；`fail` 让它们失败。 */
    const desktop = () => { if (fail) throw { code: "message", message: fail }; return null; };
    backend = fakeBackend({ image: {}, copy_reference_image: desktop, reveal_reference_image: desktop, pin_reference: desktop });
  });
  const stageOf = () => screen.getByAltText("正在查看的参考图").parentElement!;
  const openMenu = async () => {
    fireEvent.contextMenu(stageOf(), { clientX: 200, clientY: 200 });
    return screen.findByRole("menu", { name: "查看器菜单" });
  };
  const rows = (menu: HTMLElement) => [...menu.querySelectorAll("[role^='menuitem']")].map((row) => row.textContent);

  it("菜单项与 #102 表一致：危险项置底红字，三条分隔线", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} onTrash={() => {}} />);
    const menu = await openMenu();
    expect(rows(menu)).toEqual(["钉住整图P", "钉住局部F1", "复制图片", "适应窗口0", "原始像素1", "背景", "详情I", "在资源管理器中显示", "移到回收站"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(3);
    const danger = within(menu).getAllByRole("menuitem").filter((item) => item.className.includes("is-danger"));
    expect(danger.map((item) => item.textContent)).toEqual(["移到回收站"]);
  });

  it("没有回收站动作（例如在回收站里查看）时不显示“移到回收站”", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const menu = await openMenu();
    expect(rows(menu).at(-1)).toBe("在资源管理器中显示");
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("复制图片与在资源管理器中显示作用于正在看的这张；失败时说明原因", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "复制图片" }));
    await waitFor(() => expect(backend.calls("copy_reference_image")[0]?.args).toEqual({ libraryId: "L1", imageId: "a" }));
    expect(await screen.findByText("已复制图片")).toBeTruthy();
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "在资源管理器中显示" }));
    await waitFor(() => expect(backend.calls("reveal_reference_image")[0]?.args).toEqual({ libraryId: "L1", imageId: "a" }));
    fail = "原文件不在了";
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "在资源管理器中显示" }));
    expect(await screen.findByText("无法在资源管理器中显示：原文件不在了")).toBeTruthy();
  });

  it("缩放、详情与钉住走与 dock 相同的处理", async () => {
    const toggle = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} inspectorOpen onToggleInspector={toggle} />);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: /^原始像素/ }));
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: /^适应窗口/ }));
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");
    const detail = within(await openMenu()).getByRole("menuitemcheckbox", { name: /^详情/ });
    expect(detail.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(detail);
    expect(toggle).toHaveBeenCalledTimes(1);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: /^钉住局部/ }));
    expect(screen.getByRole("button", { name: /^框选局部/ }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => { fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: /^钉住整图/ })); });
    expect(backend.calls("pin_reference")).toHaveLength(1);
  });

  it("背景子菜单：选另一种即换上", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "背景" }));
    const grounds = await screen.findByRole("menu", { name: "背景" });
    fireEvent.click(within(grounds).getByRole("menuitemradio", { name: "棋盘格" }));
    await waitFor(() => expect(stageOf().getAttribute("data-background")).toBe("checker"));
  });

  it("移到回收站交给调用方；Shift+F10 打开同一菜单", async () => {
    const onTrash = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} onTrash={onTrash} />);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "移到回收站" }));
    expect(onTrash).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(screen.getByRole("region", { name: "原图查看器" }), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "查看器菜单" })).toBeTruthy();
  });
});
