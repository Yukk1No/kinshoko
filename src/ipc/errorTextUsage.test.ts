// 界面上显示错误一律走 errorText()（#483）：非命令失败的错误不能把原文拼进界面。
import { expect, it } from "vitest";

const files = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
// 允许直接转字符串的地方：写日志的 runLog、命令失败的出口 commandError、还原度实验页、测试、生成的类型。
const SKIP = [/(^|\/)fidelity\//, /\.test\.tsx?$/, /(^|\/)runLog\.ts$/, /(^|\/)commandError\.ts$/, /(^|\/)bindings\//, /(^|\/)test\//];
const CAUGHT = /\bString\(\s*(?:e|err|error|reason|cause|failure|exception)\s*\)/;

it("界面代码不用 String(e) 之类的写法显示错误，改用 errorText", () => {
  const hits = Object.entries(files).flatMap(([path, source]) =>
    SKIP.some((pattern) => pattern.test(path)) ? [] : source.split(/\r?\n/).flatMap((line, i) => (CAUGHT.test(line) ? [`${path}:${i + 1}`] : [])),
  );
  expect(Object.keys(files).length).toBeGreaterThan(100);
  expect(hits).toEqual([]);
});

// 吞掉失败的写法（#529）：`.catch(() => {})`、`.catch(() => undefined)` 与空的 `catch` 块。
const SWALLOWED = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}|undefined|null|void 0)\s*\)|\bcatch\s*(?:\(\s*\w*\s*\))?\s*\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}/g;
const IGNORED = "忽略失败：";
const QUIET_SKIP = [/\.test\.tsx?$/, /(^|\/)ui\/vendor\//, /(^|\/)perf\//, /(^|\/)bindings\//, /(^|\/)test\//];

/** 没写原因就吞掉失败的位置：上一行或空的 catch 块里要有 `忽略失败：` 注释。 */
function unexplainedSwallows(path: string, source: string): string[] {
  const lines = source.split(/\r?\n/);
  return [...source.matchAll(SWALLOWED)].flatMap((match) => {
    const line = source.slice(0, match.index).split("\n").length;
    const explained = match[0].includes(IGNORED) || (lines[line - 2] ?? "").includes(IGNORED);
    return explained ? [] : [`${path}:${line}`];
  });
}

it("吞掉失败的地方都写了原因：上一行带 `// 忽略失败：`", () => {
  const hits = Object.entries(files).flatMap(([path, source]) =>
    QUIET_SKIP.some((pattern) => pattern.test(path)) ? [] : unexplainedSwallows(path, source));
  expect(hits).toEqual([]);
});

it("去掉注释就报出位置", () => {
  expect(unexplainedSwallows("a.ts", "x;\nvoid f().catch(() => {});\ntry { g(); } catch {}\n")).toEqual(["a.ts:2", "a.ts:3"]);
  expect(unexplainedSwallows("a.ts", "// 忽略失败：收尾\nvoid f().catch(() => {});\ntry { g(); } catch { /* 忽略失败：记不住 */ }\n")).toEqual([]);
  expect(unexplainedSwallows("a.ts", "void f().catch((e) => undefined);\n")).toEqual(["a.ts:1"]);
});
