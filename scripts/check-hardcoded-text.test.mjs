import { describe, expect, it } from "vitest";
import { findHardcodedText, isSkipped } from "./check-hardcoded-text.mjs";

const lines = (text, path) => findHardcodedText(text, path).map(hit => hit.line);

describe("前端组件", () => {
  it("找出字符串、模板字符串与 JSX 文本里的中文", () => {
    const source = [
      'const a = "打开";',
      "const b = `共 ${count} 张`;",
      "return <p>没有图片</p>;",
      'const c = t("library.empty");',
    ].join("\n");
    expect(lines(source, "src/A.tsx")).toEqual([1, 2, 3]);
  });

  it("不算注释里的中文", () => {
    const source = [
      "// 行注释",
      "/* 块注释",
      "   第二行 */",
      "{/* JSX 注释 */}",
      'const url = "https://example.com"; // 地址',
    ].join("\n");
    expect(lines(source, "src/A.tsx")).toEqual([]);
  });

  it("模板插值里嵌套的字符串照样查", () => {
    const source = "const a = `${ok ? `好` : \"坏\"} x`;\n// 注释";
    expect(lines(source, "src/A.ts")).toEqual([1]);
  });

  it("JSX 文本里的撇号不会把后面的注释当成字符串", () => {
    const source = ["<p>It's fine</p>", "// 注释"].join("\n");
    expect(lines(source, "src/A.tsx")).toEqual([]);
  });
});

describe("Rust", () => {
  it("找出字符串字面量里的中文，不算注释与文档注释", () => {
    const source = [
      "/// 文档注释",
      "//! 模块文档",
      "/* 外 /* 嵌套 */ 仍是注释 */",
      'fn f() -> &str { "打开" }',
      'let raw = r#"原始"#;',
      "let c = '中';",
      "fn g<'a>(x: &'a str) {}",
    ].join("\n");
    expect(lines(source, "src-tauri/src/a.rs")).toEqual([4, 5, 6]);
  });

  it("跳过 #[cfg(test)] 标着的模块与条目", () => {
    const source = [
      'pub fn f() -> &\'static str { "界面" }',
      "#[cfg(test)]",
      "mod tests {",
      '    const A: &str = "{ 括号在字符串里";',
      "    #[test]",
      '    fn t() { assert_eq!(super::f(), "界面"); }',
      "}",
      "#[cfg(test)]",
      'const B: &str = "测试用";',
      'pub fn g() -> &\'static str { "又一个" }',
    ].join("\n");
    expect(lines(source, "crates/x/src/lib.rs")).toEqual([1, 10]);
  });

  it("不算 expect、panic 一类宏与控制台输出里的中文", () => {
    const source = [
      'let a = b.expect("已核对");',
      'unreachable!("不会到这里");',
      'eprintln!("写日志失败：{}", e);',
      "let c = d",
      '    .expect(',
      '        "跨行的消息",',
      "    );",
      'Err(format!("无法打开：{e}"))',
    ].join("\n");
    expect(lines(source, "crates/x/src/lib.rs")).toEqual([8]);
  });
});

describe("不查的文件", () => {
  it.each([
    "src/i18n/locales/zh-CN/common.ts",
    "src/bindings/Foo.ts",
    "src/App.test.tsx",
    "src/App.fixtures.tsx",
    "src-tauri/src/ui_text.rs",
    "src-tauri/src/plugin_acl_tests.rs",
    "crates/kinshoko-core/tests/library.rs",
    "crates/kinshoko-core/src/library/tests.rs",
    "crates/kinshoko-core/examples/demo.rs",
  ])("%s", path => {
    expect(isSkipped(path)).toBe(true);
  });

  it("组件与 Rust 源码要查", () => {
    expect(isSkipped("src/App.tsx")).toBe(false);
    expect(isSkipped("src-tauri/src/commands.rs")).toBe(false);
  });
});
