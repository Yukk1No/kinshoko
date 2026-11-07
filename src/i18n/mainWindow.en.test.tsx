import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { i18n } from ".";
import { MenuPopup } from "../ui/Menu";
import { ImportButton } from "../ui/ImportButton";
import { WallMenu, type WallMenuActions, type WallMenuTarget } from "../wall/WallMenu";
import { ViewerMenu } from "../viewer/ViewerParts";
import type { BrowserCard } from "../wall/Wall";
import type { BrowseScope } from "../bindings/BrowseScope";
import { expectNoChinese } from "../test/noChinese";

// 英文界面下主窗口各处没有中文界面文案（#356）。中文界面的文案由各组件自己的测试核对。
beforeEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });
afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

const card = (id: string): BrowserCard => ({
  id, width: 100, height: 100, adult: false, libraryId: "L1", imageId: `i${id}`,
  sources: [
    { libraryId: "L1", libraryName: "库一", imageId: `i${id}`, unavailable: null, matches: true, deleted: false },
    { libraryId: "L2", libraryName: "库二", imageId: `j${id}`, unavailable: null, matches: true, deleted: false },
  ],
});

const actions = (): WallMenuActions => ({
  open: vi.fn(), pin: vi.fn(), crop: vi.fn(), edit: vi.fn(), addToGroup: vi.fn(), inspectSources: vi.fn(),
  purge: vi.fn(), importFrom: vi.fn(), selectAll: vi.fn(), setDensity: vi.fn(),
  copy: vi.fn(), reveal: vi.fn(), importClipboard: vi.fn(), clipboardHasImage: vi.fn(async () => true),
  folders: vi.fn(async () => []), inFolder: vi.fn(async () => true), groups: vi.fn(async () => []),
});

function wallMenu(target: WallMenuTarget, scope: BrowseScope = { kind: "all" }) {
  render(<ContextMenu.Root open><MenuPopup label="menu"><WallMenu target={target} scope={scope} density={240} actions={actions()} /></MenuPopup></ContextMenu.Root>);
  return screen.getByRole("menu");
}

describe("英文界面：图片墙", () => {
  const point = { x: 0, y: 0 };

  it("单张、多张、回收站与空白处的菜单", async () => {
    expectNoChinese(wallMenu({ kind: "cards", cards: [card("1")], point }, { kind: "folder", id: "f" }));
    expect(await screen.findByRole("menuitem", { name: "Remove from this folder" })).toBeTruthy();
    cleanup();
    expectNoChinese(wallMenu({ kind: "cards", cards: [card("1"), card("2")], point }));
    expect(screen.getByRole("menuitem", { name: /Pin 2 images/ })).toBeTruthy();
    cleanup();
    expectNoChinese(wallMenu({ kind: "cards", cards: [card("1")], point }, { kind: "trash" }));
    cleanup();
    expectNoChinese(wallMenu({ kind: "blank", point }));
  });

  it("子菜单：文件夹、参考组、内容分级与图片大小", async () => {
    const menu = wallMenu({ kind: "cards", cards: [card("1")], point });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    expect(await screen.findByText("This library has no folders yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Content rating" }));
    expect(await screen.findByRole("menuitem", { name: "Adult" })).toBeTruthy();
    expectNoChinese(menu.ownerDocument.body);
  });
});

describe("英文界面：查看器与导入按钮", () => {
  it("查看器菜单", () => {
    render(<ContextMenu.Root open><ViewerMenu pin={vi.fn()} pinPart={vi.fn()} copy={vi.fn()} reveal={vi.fn()} reset={vi.fn()}
      background="mid" setBackground={vi.fn()} inspectorOpen onToggleInspector={vi.fn()} onTrash={vi.fn()} /></ContextMenu.Root>);
    fireEvent.click(screen.getByRole("menuitem", { name: "Background" }));
    expectNoChinese(document.body);
  });

  it("导入按钮与它的菜单", () => {
    render(<ImportButton onFiles={vi.fn()} onFolder={vi.fn()} onEagle={vi.fn()} onShowTasks={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("menuitem", { name: "Import from Eagle" })).toBeTruthy();
    expectNoChinese(document.body);
  });
});
