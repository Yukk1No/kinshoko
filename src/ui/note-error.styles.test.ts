import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!./note-error.styles.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const RETIRED = [
  "k-set-note",
  "k-set-hint",
  "k-set-error",
  "k-set-load-error",
  "settings-error",
  "k-field-error",
  "create-library-error",
  "selection-note",
  "insp-hint",
];
const ALLOWED: Record<string, string> = {
  ".pw-band-tags": "图片墙的标签摘要，不是说明段落",
  ".insp-file-meta": "文件元数据行",
  ".inspector .selection-version": "版本读数",
  ".welcome-back": "返回入口的链接",
  ".k-tags .k-tags-sub": "标签区的操作行",
  ".k-tag-kind": "标签类型标记",
  ".k-row .sidebar-count": "侧栏计数",
  ".lib-head-name .sidebar-count": "资料库计数",
  ".search-extras .result-count": "搜索计数",
  ".capture-history-meta": "截图元数据",
  ".reference-group-meta, .reference-group-problem": "参考组元数据行",
  ".capture-save-head span": "截图保存目标的读数",
  ".group-any": "标签分组的匹配条件标记",
  ".k-empty.is-list": "列表内空状态使用共用组件的 12 / 18 字形",
  ".k-token-count": "标签计数",
  ".legacy-name-migration .settings-shortcuts small": "迁入列表里的元数据",
  ".save-destination legend": "保存目标字段名",
  ".selection-hint": "选择栏的状态读数",
  ".viewer-index": "查看器页码",
  ".subs-account-sub": "订阅账号行的元数据，订阅页行样式另行收拢",
  ".subs-check": "订阅页的复选控件",
  ".subs-follow-count": "订阅关注列表的计数",
  ".subs-rank-foot-note": "榜单页脚，订阅页行样式另行收拢",
  ".k-task-count": "任务计数",
  ".k-task-sub": "任务状态行，任务区域另行收拢",
  ".k-task-stats": "任务统计读数",
  ".k-task-more": "任务展开按钮",
  ".k-task-switch": "任务切换按钮",
  ".k-group-count": "分组计数",
  ".k-set-number": "设置里的数值读数",
  ".k-check": "复选控件",
  ".k-radio-desc": "单选控件内的描述，控件布局不在本次范围",
  ".k-steps-count": "步骤计数",
  ".k-option-via": "候选项的匹配来源，浮层不在本次范围",
  ".k-set-version": "设置侧栏的版本读数",
  ".k-set-row-below-body": "行下方内容的容器，不是文字角色",
  ".k-set-muted": "设置中的次要读数",
  ".k-lang": "语言选项控件",
  ".k-toast-desc": "浮动通知不在本次范围",
  ".k-list-desc": "列表行的描述，行组件不在本次范围",
  ".k-list-meta": "列表行的元数据",
  ".k-item-meta": "菜单元数据，浮层不在本次范围",
  ".k-item.is-tip": "菜单状态行，浮层不在本次范围",
  ".desk-groups-toggle .sidebar-count": "参考组侧栏段标题的计数，同 .k-row .sidebar-count",
  ".desk-group-day-head": "成员区按天分段的日期读数",
  ".desk-group-closed-toggle": "“已关闭 N 张”的展开按钮",
};

function typeRoleRules(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => {
      if (!/font-size:\s*12px\s*(?:;|$)/.test(body)) return false;
      return (
        /(?:^|;)\s*color:\s*var\(--danger\)/.test(body) ||
        (/(?:^|;)\s*color:\s*var\(--ink-2\)/.test(body) && !/font-weight:\s*600\s*(?:;|$)/.test(body))
      );
    })
    .map(([, selector]) => selector.trim().replace(/\s+/g, " "));
}

describe("说明与报错文字", () => {
  it("旧类名不再出现在 src/", () => {
    const hits = Object.entries({ ...sheets, ...sources }).flatMap(([path, text]) =>
      RETIRED.filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)).map((name) => `${path}: ${name}`),
    );
    expect(hits).toEqual([]);
  });

  it("字形只在共用类里定义", () => {
    const hits = Object.entries(sheets).flatMap(([path, css]) =>
      typeRoleRules(css)
        .filter((selector) => !(path === "./ui.css" && [".k-description", ".k-error-text"].includes(selector)))
        .filter((selector) => !(selector in ALLOWED))
        .map((selector) => `${path}: ${selector}`),
    );
    expect(hits).toEqual([]);
  });

  it("说明 12 / 18 次要墨色，报错 12 危险色并保留继承行高", () => {
    expect(cssRule(sheets["./ui.css"], ".k-description")).toMatchObject({
      margin: "0",
      "font-size": "12px",
      "line-height": "18px",
      color: "var(--ink-2)",
    });
    const error = cssRule(sheets["./ui.css"], ".k-error-text");
    expect(cssRule(sheets["./ui.css"], ".k-description:where(.is-body)")).toEqual({
      "font-size": "13px",
      "line-height": "inherit",
    });
    expect(error).toMatchObject({
      margin: "0",
      "font-size": "12px",
      color: "var(--danger)",
      "overflow-wrap": "anywhere",
    });
    expect(error).not.toHaveProperty("line-height");
    expect(cssRule(sheets["./ui.css"], ".k-error-text:where(.is-field)")).toMatchObject({
      display: "flex",
      "align-items": "center",
      gap: "6px",
      "line-height": "18px",
      "overflow-wrap": "normal",
    });
    expect(cssRule(sheets["./ui.css"], ".k-error-text:where(.is-boxed)")).toMatchObject({
      "margin-bottom": "12px",
      padding: "8px 12px",
      "border-radius": "var(--r)",
      background: "var(--surface-2)",
    });
  });

  it("共用修饰符保持单类优先级，让区域间距规则覆盖", () => {
    const selectors = [...sheets["./ui.css"].matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => /^\.k-(?:description|error-text)[.:]/.test(selector));
    expect(selectors).toEqual([
      ".k-description:where(.is-spaced)",
      ".k-description:where(.is-body)",
      ".k-error-text:where(.is-boxed)",
      ".k-error-text:where(.is-field)",
    ]);
    expect(cssRule(sheets["../library/import.css"], ".save-destination p")).toMatchObject({ margin: "0" });
    expect(
      cssRule(sheets["../settings/settings.css"], ".k-set-row-below-body > p,\n.k-set-row-below-body > div > p"),
    ).toMatchObject({
      margin: "4px 0",
    });
    expect(cssRule(sheets["../settings/settings.css"], ".k-set-row-below-body .k-error-text")).toMatchObject({
      margin: "6px 0 0",
    });
  });

  it("检测器区分说明、报错、分组名和空规则", () => {
    expect(typeRoleRules("")).toEqual([]);
    expect(typeRoleRules(".group { font-size: 12px; font-weight: 600; color: var(--ink-2); }")).toEqual([]);
    expect(typeRoleRules(".note { color: var(--ink-2); font-size: 12px; }")).toEqual([".note"]);
    expect(typeRoleRules(".error { font-size: 12px; color: var(--danger); }")).toEqual([".error"]);
    expect(typeRoleRules(".border { font-size: 12px; border-color: var(--danger); }")).toEqual([]);
  });

  it("区域保留说明的间距、键盘显示和检查器行高", () => {
    expect(cssRule(sheets["./ui.css"], ".k-description:where(.is-spaced)")).toMatchObject({ "margin-top": "8px" });
    expect(cssRule(sheets["../settings/settings.css"], ".k-set-group > .k-description")).toMatchObject({
      margin: "0",
      padding: "8px 12px 6px",
    });
    expect(cssRule(sheets["../settings/settings.css"], ".k-set-row .k-list-text > .k-description")).toMatchObject({
      display: "none",
      "white-space": "normal",
    });
    expect(cssRule(sheets["../shell/sidebar.css"], ".workspace-sources > .k-description")).toMatchObject({
      margin: "6px 0 0",
      "line-height": "inherit",
      display: "flex",
      "flex-wrap": "wrap",
      gap: "6px",
    });
  });
});
