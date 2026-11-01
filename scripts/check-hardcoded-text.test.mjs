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

  it("正则里的 /* 与 // 不当成注释，除号照常", () => {
    const source = [
      "const punctuation = /[/*]/;",
      'const label = "打开";',
      "if (/\\/\\//.test(s)) x = a / b; // 注释",
      'const half = total / 2; const t = "一半";',
      "return <p>完</p>;",
    ].join("\n");
    expect(lines(source, "src/A.tsx")).toEqual([2, 4, 5]);
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

  it("不算日志与运行日志里的中文", () => {
    const source = [
      'log::warn!("同步失败：{e}");',
      'crate::run_log::error("打开主窗口失败", e);',
      'took("浏览：一页", started, None);',
      'self.effects.push(Effect::Warn("画不上", e));',
      'let _held = HeldLock::acquired("登记表", site, waiting);',
      'Err(format!("界面上的"))',
    ].join("\n");
    expect(lines(source, "src-tauri/src/a.rs")).toEqual([6]);
  });

  it("错误代码后面的日志说明不算，代码本身与原样显示的错误照查", () => {
    const source = [
      'CommandError::new(ErrorKind::NoLibrary, "还没有资料库")',
      "GroupError::invalid(",
      "    ErrorKind::GroupMemberDuplicate { member: m.id.clone() },",
      '    format!("成员 {} 重复", m.id),',
      ")",
      'BackupError::incomplete(crate::command_error::ErrorKind::RestoreJournalMismatch, "身份不符")',
      'CommandError::new(ErrorKind::Undecodable { detail: "不支持的格式".into() }, "原图无法解码")',
      'CommandError::system("原样显示")',
      'CommandError::without_code("原样显示")',
      'wrap(ErrorKind::Message { message: "原样显示".into() }, "说明")',
    ].join("\n");
    expect(lines(source, "crates/x/src/lib.rs")).toEqual([7, 8, 9, 10]);
  });

  it("Display 实现整块不算", () => {
    const source = [
      "impl fmt::Display for Error {",
      "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
      '        match self { Error::A => write!(f, "日志里的说明"), Error::B => f.write_str("{") }',
      "    }",
      "}",
      'fn label() -> &\'static str { "界面" }',
    ].join("\n");
    expect(lines(source, "crates/x/src/lib.rs")).toEqual([6]);
  });

  it("“不上界面”标记豁免紧跟着的一个条目，没写原因的不算", () => {
    const source = [
      "// 不上界面：只写进诊断报告",
      "/// 文档注释",
      "#[inline]",
      "fn report() -> String {",
      '    format!("诊断信息")',
      "}",
      "// 不上界面：搜索时认的叫法",
      'const NAMES: [(u8, &str); 2] = [(1, "全年龄"), (2, "成人")];',
      'const AFTER: &str = "照查";',
      "// 不上界面：",
      'const NO_REASON: &str = "照查";',
    ].join("\n");
    expect(lines(source, "crates/x/src/lib.rs")).toEqual([9, 11]);
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
    "crates/kinshoko-core/src/fidelity/gate.rs",
    "src-tauri/src/fidelity_gate/pins.rs",
  ])("%s", path => {
    expect(isSkipped(path)).toBe(true);
  });

  it("组件与 Rust 源码要查", () => {
    expect(isSkipped("src/App.tsx")).toBe(false);
    expect(isSkipped("src-tauri/src/commands.rs")).toBe(false);
  });
});
