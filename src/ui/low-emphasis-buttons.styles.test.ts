import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";

const sources = import.meta.glob<string>(["../**/*.{css,ts,tsx}", "!./low-emphasis-buttons.styles.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const RETIRED = ["is-ghost", "is-flush"];
const ALLOWED: Record<string, string> = {};
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });
const FOOTER = ".legacy-name-migration > .k-dialog-foot > .k-link";
const REVERT = ".k-note .k-note-acts .selection-revert-note:disabled";
const CONTEXTUAL_ALLOWED: Record<string, string> = {
  [FOOTER]: "迁入页脚保留原按钮的尺寸和对齐",
  [`${FOOTER}:active:not(:disabled)`]: "迁入页脚保留原按钮的按压位移",
  [`${FOOTER}:disabled`]: "迁入页脚保留原按钮不可用时的细线",
};

function selectors(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(([, selector]) =>
    selector.trim().split(/,\s*/),
  );
}

function retiredClasses(text: string): string[] {
  return RETIRED.filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text));
}

describe("低强调按钮", () => {
  it("不恢复图库备份的按钮不可用时保留细线", () => {
    expect(cssRule(sheets["./dialogs-tasks.css"], ".k-task-acts .import-backup-dismiss:disabled")).toEqual({
      "--k-lift": "var(--btn-lift-disabled)",
    });
    expect(sources["../library/ImportCards.tsx"]).toContain('className="k-btn is-sm is-quiet import-backup-dismiss"');
  });

  it("警示只是无底按钮的语气，不改变尺寸或焦点", () => {
    const base = ".k-btn.is-quiet.is-warn";
    expect(
      Object.entries(sheets).flatMap(([path, css]) =>
        selectors(css)
          .filter((selector) => selector === base)
          .map(() => path),
      ),
    ).toEqual(["./ui.css"]);
    expect(cssRule(sheets["./ui.css"], base)).toEqual({
      "--k-face": "transparent",
      "--k-face-hover": "var(--warn-soft)",
      "--k-face-press": "var(--warn-soft)",
      color: "var(--warn)",
    });
    for (const state of ["hover", "active"]) {
      expect(cssRule(sheets["./ui.css"], `${base}:${state}:not(:disabled)`)).toEqual({
        color: "var(--warn-strong)",
      });
    }
  });

  it("两种共用样式各只有一份，区域调整有理由", () => {
    const shared = [".k-btn.is-quiet", ".k-link"];
    for (const base of shared) {
      expect(
        Object.entries(sheets).flatMap(([path, css]) =>
          selectors(css)
            .filter((selector) => selector === base)
            .map(() => path),
        ),
      ).toEqual(["./ui.css"]);
    }
    const hits = Object.entries(sheets).flatMap(([path, css]) =>
      selectors(css)
        .filter((selector) => shared.some((base) => selector.includes(base)))
        .filter(
          (selector) =>
            !(
              path === "./ui.css" &&
              [
                ".k-btn.is-quiet",
                ".k-btn.is-quiet:hover:not(:disabled)",
                ".k-btn.is-quiet.is-warn",
                ".k-btn.is-quiet.is-warn:hover:not(:disabled)",
                ".k-btn.is-quiet.is-warn:active:not(:disabled)",
                ".k-link",
                ".k-link:hover:not(:disabled)",
                ".k-link:disabled",
              ].includes(selector)
            ),
        )
        .filter((selector) => !(path === "./dialogs.css" && selector in CONTEXTUAL_ALLOWED))
        .map((selector) => `${path}: ${selector}`),
    );
    expect(hits).toEqual([]);
  });

  it("无底按钮和文字链接使用共用颜色与状态，不另画焦点", () => {
    const css = sheets["./ui.css"];
    expect(cssRule(css, ".k-btn.is-quiet")).toMatchObject({
      "--k-face": "transparent",
      "--k-face-hover": "var(--hover)",
      "--k-face-press": "var(--press)",
      "--k-lift": "none",
      "--k-lift-hover": "none",
      "--k-lift-press": "none",
      color: "var(--ink-2)",
    });
    expect(cssRule(css, ".k-btn.is-quiet:hover:not(:disabled)")).toMatchObject({ color: "var(--ink)" });
    expect(cssRule(css, ".k-link")).toMatchObject({ color: "var(--accent-strong)", background: "none" });
    expect(cssRule(css, ".k-link:hover:not(:disabled)")).toMatchObject({ "text-decoration": "underline" });
    expect(cssRule(css, ".k-link:disabled")).toMatchObject({ opacity: "var(--disabled-opacity)" });
    for (const sheet of Object.values(sheets)) {
      for (const selector of selectors(sheet).filter((selector) =>
        /\.k-btn\.is-quiet(?![\w-])|\.k-link(?![\w-])/.test(selector),
      )) {
        expect(
          Object.keys(cssRule(sheet.replace(/\/\*[\s\S]*?\*\//g, ""), selector)).filter((name) =>
            name.startsWith("outline"),
          ),
        ).toEqual([]);
      }
    }
  });

  it("迁入页脚保留按钮尺寸、按压和不可用细线", () => {
    const css = sheets["./dialogs.css"];
    expect(cssRule(css, FOOTER)).toMatchObject({
      height: "var(--h)",
      padding: "0 12px 0 0",
      "border-radius": "var(--r)",
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
    });
    expect(cssRule(css, FOOTER).transition.replace(/\s+/g, " ")).toBe(
      "background var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast) var(--spring)",
    );
    expect(cssRule(css, `${FOOTER}:active:not(:disabled)`)).toMatchObject({ transform: "translateY(0.5px)" });
    expect(cssRule(css, `${FOOTER}:disabled`)).toMatchObject({ "box-shadow": "var(--btn-lift-disabled)" });
    expect(sources["../library/LegacyNameMigrationPanel.tsx"]).toContain(
      '<span className="k-label">{t("bulk", { count: bulk.length })}</span>',
    );
  });

  it("改回来源备注不可用时保留细线，不改其他无底按钮", () => {
    expect(cssRule(sheets["../shell/inspector.css"], REVERT)).toMatchObject({
      "--k-lift": "var(--btn-lift-disabled)",
    });
    expect(sources["../library/SelectionPanel.tsx"]).toContain(
      'className="k-btn is-sm is-quiet selection-revert-note"',
    );
  });

  it("迁入页脚的文字链接不带行内链接的左外边距", () => {
    expect(cssRule(sources["./dialogs.css"], ".legacy-name-migration > .k-dialog-foot > .k-link")).toMatchObject({
      "margin-left": "0",
    });
  });

  it("旧类名不再出现在 src/ 的用处或样式定义里", () => {
    const hits = Object.entries(sources).flatMap(([path, text]) =>
      retiredClasses(text)
        .map((name) => `${path}: ${name}`)
        .filter((hit) => !(hit in ALLOWED)),
    );
    expect(hits).toEqual([]);
  });

  it("扫描认得完整类名，跳过空文本和无关类名", () => {
    expect(retiredClasses("")).toEqual([]);
    expect(retiredClasses('className="k-btn is-ghost is-sm"')).toEqual(["is-ghost"]);
    expect(retiredClasses(".k-btn.is-flush:hover { padding: 0; }")).toEqual(["is-flush"]);
    expect(retiredClasses("fx-ghost tray-ghost subs-section is-quiet is-ghostly prefix-is-flush")).toEqual([]);
  });
});
