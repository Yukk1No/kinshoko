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
