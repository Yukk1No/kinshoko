import { describe, expect, it } from "vitest";
import index from "../styles.css?raw";

// 样式入口显式建立 cascade layers（#740）。新样式表必须在这里归位：先决定它属于令牌/基础、共用件、窗口框架还是功能定制，
// 再写进 src/styles.css 与本表；层优先级高于选择器特异性，不能只按迁移前的文件次序判断。
const LAYERS = "@layer tokens, base, ui, layout, feature;";
const EXPECTED: Record<string, string> = {
  "./styles/tokens.css": "tokens",
  "./styles/base.css": "base",
  "./search/search.css": "ui",
  "./library/tag-panel.css": "ui",
  "./shell/sidebar-base.css": "ui",
  "./ui/ui.css": "ui",
  "./ui/page-frame.css": "ui",
  "./ui/media-card.css": "ui",
  "./ui/empty-state.css": "ui",
  "./ui/token.css": "ui",
  "./ui/spinner.css": "ui",
  "./ui/ui-dock.css": "ui",
  "./ui/menu.css": "ui",
  "./ui/toast.css": "ui",
  "./ui/fields.css": "ui",
  "./ui/row.css": "ui",
  "./ui/text-select.css": "ui",
  "./shell/rail.css": "layout",
  "./shell/page-swap.css": "layout",
  "./shell/seal-fx.css": "layout",
  "./shell/frame.css": "layout",
  "./shell/topbar.css": "layout",
  "./shell/sidebar.css": "layout",
  "./shell/startup-splash.css": "layout",
  "./pixiv/pixiv.css": "feature",
  "./library/selection.css": "feature",
  "./viewer/viewer.css": "feature",
  "./desktop/capture-history.css": "feature",
  "./desktop/capture.css": "feature",
  "./fidelity/fidelity-gate.css": "feature",
  "./search/tag-groups.css": "feature",
  "./library/import.css": "feature",
  "./library/legacy-name-migration.css": "feature",
  "./wall/wall-floats.css": "feature",
  "./shell/inspector.css": "feature",
  "./shell/welcome.css": "feature",
  "./shell/inspector-tags.css": "feature",
  "./wall/wall.css": "feature",
  "./desktop/desk-groups.css": "feature",
  "./settings/settings.css": "feature",
  "./ui/dialogs.css": "feature",
  "./ui/dialogs-tasks.css": "feature",
  "./search/search-bar.css": "feature",
  "./subscriptions/subscriptions.css": "feature",
};

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function importEntries(css: string): [string, string][] {
  return [...css.matchAll(/@import "(\.\/[^"]+)"(?:\s+layer\((tokens|base|ui|layout|feature)\))?;/g)].map(
    ([, path, layer]) => [path, layer ?? ""],
  );
}

function imports(css: string): Record<string, string> {
  return Object.fromEntries(importEntries(css));
}

function rootImportPath(path: string): string {
  if (path.startsWith("./")) return `./styles/${path.slice(2)}`;
  return `./${path.slice(3)}`;
}

function directCssImports(path: string, source: string): string[] {
  const staticImports = [...source.matchAll(/^import\s*["']([^"']+\.css)["'];?/gm)].map(
    ([, spec]) => `${path}: ${spec}`,
  );
  const dynamicImports = [...source.matchAll(/import\(\s*["']([^"']+\.css)["']\s*\)/g)].map(
    ([, spec]) => `${path}: import(${spec})`,
  );
  return [...staticImports, ...dynamicImports];
}

describe("CSS cascade layers", () => {
  it("样式入口先声明 tokens、base、ui、layout、feature 的顺序", () => {
    expect(index).toContain(LAYERS);
    expect(index.indexOf(LAYERS)).toBeLessThan(index.indexOf("@import"));
  });

  it("每份样式表从入口导入一次，按预期次序归入预期层", () => {
    expect(importEntries(index)).toEqual(Object.entries(EXPECTED));
    const files = Object.keys(sheets)
      .filter((path) => path !== "../styles.css")
      .map(rootImportPath)
      .sort();
    expect(files).toEqual(Object.keys(EXPECTED).sort());
  });

  it("生产 TS 不绕过入口直接导入部件样式", () => {
    const direct = Object.entries(sources).flatMap(([path, source]) => directCssImports(path, source));
    expect(direct).toEqual(["../main.tsx: ./styles.css"]);
  });

  it("扫描能认出没有归层的导入与 TS 里的直接导入", () => {
    expect(imports('@import "./x.css";')).toEqual({ "./x.css": "" });
    expect(imports('@import "./x.css" layer(feature);')).toEqual({ "./x.css": "feature" });
    expect(directCssImports("x.ts", 'import "./x.css";\nawait import("./y.css");')).toEqual([
      "x.ts: ./x.css",
      "x.ts: import(./y.css)",
    ]);
  });
});
