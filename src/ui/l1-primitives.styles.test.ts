import { describe, expect, it } from "vitest";
import tokens from "../styles/tokens.css?raw";
import { cssRule } from "./cssRule";
import mediaCard from "./media-card.css?raw";
import pageFrame from "./page-frame.css?raw";
import uiDock from "./ui-dock.css?raw";

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

// #743/#763 之后仍待迁移的既有对话框。新对话框不能直接从 Base UI 导入底层对话框原语，
// 也不能手写关闭叉或底部操作区；迁移一个就从这里删一个，删完保留空表作为护栏。
const DIRECT_DIALOG_ALLOWLIST = new Set([
  "../library/ImportBar.tsx",
  "../library/ImportBarParts.tsx",
  "../library/PermanentDeleteBatch.tsx",
  "../library/SealedImportPreview.tsx",
]);
const MANUAL_CLOSE_ALLOWLIST = new Set(["../library/SealedImportPreview.tsx"]);
const MANUAL_FOOTER_ALLOWLIST = new Set(["../library/ImportBarParts.tsx", "../library/PermanentDeleteBatch.tsx"]);
// 主墙仍是未迁移的遗留实现；新墙与浏览页统一走 MediaCardFrame。
const LEGACY_CARD_CSS = new Set(["../wall/wall.css"]);

const BASE_UI_DIALOG_SPECIFIER = /(?:from\s+|import\s*\(\s*)["']@base-ui\/react\/(?:alert-)?dialog(?:\/[^"']*)?["']/;
const BASE_UI_ROOT_DIALOG_IMPORT =
  /\b(?:import|export)\s*\{[^}]*\b(?:Alert)?Dialog\b[^}]*\}\s*from\s*["']@base-ui\/react["']/;
const MANUAL_CLOSE_CLASS = /\bk-dialog-x\b/;
const HEADER_SELECTOR = /(?:^|[,\s])\.(?:topbar|pw-tabs|pane-head|insp-head|startup-head|pw-subbar)\b/;
const HARD_HEADER_HEIGHT = /(?:min-)?height:\s*(?:56|48)px\b/;

function importsBaseUiDialog(source: string): boolean {
  return BASE_UI_DIALOG_SPECIFIER.test(source) || BASE_UI_ROOT_DIALOG_IMPORT.test(source);
}

function rules(css: string): [string, string][] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
}

function hardcodedHeaderHeights(css: string): string[] {
  return rules(css)
    .filter(([selector, body]) => HEADER_SELECTOR.test(selector) && HARD_HEADER_HEIGHT.test(body))
    .map(([selector]) => selector);
}

function copiedCardSelections(css: string): string[] {
  return rules(css)
    .filter(
      ([selector, body]) =>
        /(?:^|[.\s:])(?:[\w-]*card[\w-]*)\b/i.test(selector) &&
        /aria-selected|data-selected|data-on/.test(selector) &&
        /(?:outline|box-shadow)\s*:[^;]*var\(--accent/.test(body),
    )
    .map(([selector]) => selector);
}

describe("L1 骨架原语样式", () => {
  it("页面骨架高度只从两个页面令牌取", () => {
    expect(tokens).toContain("--page-topbar-h: 56px");
    expect(tokens).toContain("--page-subbar-h: 48px");
    expect(cssRule(pageFrame, ".k-page-topbar").height).toBe("var(--page-topbar-h)");
    expect(cssRule(pageFrame, ".k-page-topbar")["min-height"]).toBe("var(--page-topbar-h)");
    expect(cssRule(pageFrame, ".k-page-subbar")["min-height"]).toBe("var(--page-subbar-h)");
  });

  it("媒体卡片选中描边、焦点环与四角槽位锁在原语里", () => {
    const selected = cssRule(mediaCard, '.k-media-card[data-selected="true"]');
    expect(selected.outline).toBe("0");
    expect(selected["box-shadow"].replace(/\s+/g, " ")).toBe("0 0 0 2px var(--wall), 0 0 0 4px var(--accent)");
    expect(cssRule(mediaCard, ".k-media-card:has(.k-media-card-open:focus-visible)").outline).toBe("var(--focus-ring)");
    expect(cssRule(mediaCard, ".k-media-corner").position).toBe("absolute");
    expect(cssRule(mediaCard, ".k-media-corner.is-bottomEnd").right).toBe("8px");
  });

  it("对话框外壳的容器焦点不画环，关闭叉属于外壳", () => {
    expect(cssRule(uiDock, ".k-dialog:focus-visible").outline).toBe("0");
    expect(cssRule(uiDock, ".k-dialog-x").position).toBe("absolute");
    expect(cssRule(uiDock, ".k-dialog-foot").display).toBe("flex");
  });
});

describe("L1 静态护栏", () => {
  it("业务模块不能直接导入 Base UI 底层对话框原语", () => {
    const offenders = Object.entries(sources)
      .filter(
        ([path, source]) =>
          path !== "./DialogShell.tsx" && !DIRECT_DIALOG_ALLOWLIST.has(path) && importsBaseUiDialog(source),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("业务模块不能手写 k-dialog-x 关闭叉", () => {
    const offenders = Object.entries(sources)
      .filter(
        ([path, source]) =>
          path !== "./DialogShell.tsx" && !MANUAL_CLOSE_ALLOWLIST.has(path) && MANUAL_CLOSE_CLASS.test(source),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("业务模块不能手写 k-dialog-foot 底部操作区", () => {
    const offenders = Object.entries(sources)
      .filter(
        ([path, source]) =>
          path !== "./DialogShell.tsx" && !MANUAL_FOOTER_ALLOWLIST.has(path) && source.includes("k-dialog-foot"),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("顶栏 56 与次栏 48 不在业务样式里重写数字", () => {
    const offenders = Object.entries(sheets).flatMap(([path, css]) =>
      hardcodedHeaderHeights(css).map((selector) => `${path}: ${selector}`),
    );
    expect(offenders).toEqual([]);
  });

  it("卡片选中描边不复制到功能样式", () => {
    const offenders = Object.entries(sheets)
      .filter(([path]) => path !== "./media-card.css" && !LEGACY_CARD_CSS.has(path))
      .flatMap(([path, css]) => copiedCardSelections(css).map((selector) => `${path}: ${selector}`));
    expect(offenders).toEqual([]);
  });

  it("扫描能认出直接导入底层对话框、手写关闭叉、手写高度与复制选中描边", () => {
    expect(importsBaseUiDialog('import { Dialog } from "@base-ui/react/dialog";')).toBe(true);
    expect(importsBaseUiDialog('import { Dialog as BaseDialog } from "@base-ui/react/dialog";')).toBe(true);
    expect(importsBaseUiDialog("import * as BaseAlert from '@base-ui/react/alert-dialog';")).toBe(true);
    expect(importsBaseUiDialog('export { AlertDialog } from "@base-ui/react/alert-dialog";')).toBe(true);
    expect(importsBaseUiDialog('const mod = import("@base-ui/react/dialog");')).toBe(true);
    expect(importsBaseUiDialog('import { Dialog as BaseDialog } from "@base-ui/react";')).toBe(true);
    expect(importsBaseUiDialog('import { DialogShell } from "../ui/DialogShell";')).toBe(false);
    expect(importsBaseUiDialog('import { Menu } from "@base-ui/react/menu";')).toBe(false);
    expect(MANUAL_CLOSE_CLASS.test('<button className="k-icon-btn k-dialog-x" />')).toBe(true);
    expect(hardcodedHeaderHeights(".pw-tabs { height: 56px } .pw-subbar{min-height:48px}")).toEqual([
      ".pw-tabs",
      ".pw-subbar",
    ]);
    expect(copiedCardSelections(".pw-card[data-on] { outline: 3px solid var(--accent-strong); }")).toEqual([
      ".pw-card[data-on]",
    ]);
  });
});
