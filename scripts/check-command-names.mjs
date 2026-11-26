// 核对前端调用的命令名与 Rust 注册的命令（#525）：前端写错或漏改命令名，运行时只表现为被吞掉的 rejected promise。
//
// 命令登记在 command_registry.rs，分三组：app 对应 invoke("name")，
// library 对应 lib("name")，desktop 对应 desk("name")。
// 规则：前端出现的命令名必须在对应组注册过；注册过的命令必须在前端出现，或写进下面的 EXCEPTIONS。
// EXCEPTIONS 里已不需要的条目也算失败。
//
// 用法：node scripts/check-command-names.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const COMMAND_REGISTRY = "src-tauri/src/command_registry.rs";
const GROUPS = ["app", "library", "desktop"];

/** 注册了却不在前端出现的命令：组 → { 命令名: 理由 }。 */
export const EXCEPTIONS = {
  app: {
    file_drop_ack: "由主窗口的 WebView2 初始化脚本调用",
  },
  library: {
    switch_library: "仅 e2e 使用",
  },
  desktop: {
    pin_clipboard: "仅 e2e 使用",
    start_capture: "仅 e2e 使用",
  },
};

/** 不扫的前端路径（相对仓库根、用 / 分隔）。 */
const SKIP = [/\.test\.tsx?$/, /fixture/, /^src\/test\//, /^src\/bindings\//];

/** 去掉 // 与 /* *\/ 注释，保留换行（行号不变）。字符串内的 // 不当作注释。 */
function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === quote) quote = null;
      i++;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** 读取 command_registry! 指定组里的命令名，去掉模块路径和平台属性。 */
export function registeredCommands(source, group) {
  const marker = new RegExp(`\\(\\s*${group}\\s*,\\s*\\$emit:ident\\s*\\)\\s*=>\\s*\\{\\s*\\$emit!\\s*\\[`);
  const text = stripComments(source).replace(/#\[[^\]]*\]/g, "");
  const start = marker.exec(text);
  if (!start) throw new Error(`${COMMAND_REGISTRY} 缺少 ${group} 组`);
  const end = text.indexOf("]", start.index + start[0].length);
  if (end === -1) throw new Error(`${COMMAND_REGISTRY} 的 ${group} 组缺少结束符`);
  return text
    .slice(start.index + start[0].length, end)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.split("::").pop());
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** 一个前端文件里的命令调用：[{ group, name, line }]。整个文件当一个字符串匹配，所以跨行的调用也算。 */
export function frontendCalls(source) {
  const text = stripComments(source);
  const calls = [];
  const add = (group, match, offset) => calls.push({ group, name: match[offset], line: lineOf(text, match.index) });
  // 字面量取整段引号内的内容（不限于标识符字符），写错成带空格或符号的名字也会被当作未注册报出来。
  for (const m of text.matchAll(/\blib\(\s*(["'])([^"'\n]*)\1\s*\)/g)) add("library", m, 2);
  for (const m of text.matchAll(/\bdesk\(\s*(["'])([^"'\n]*)\1\s*\)/g)) add("desktop", m, 2);
  for (const m of text.matchAll(/\b(?:invoke|tauriInvoke)\b(?:<[^;]*?>)?\(\s*(["'])([^"'\n]*)\1/g)) add("app", m, 2);
  return calls;
}

/**
 * registered: { 组: 命令名[] }；calls: [{ group, name, file, line }]。返回问题列表（每项一行文字）。
 */
export function findProblems({ registered, calls, exceptions = EXCEPTIONS }) {
  const problems = [];
  const used = {};
  for (const group of Object.keys(registered)) used[group] = new Set();
  for (const { group, name, file, line } of calls) {
    used[group].add(name);
    if (!registered[group].includes(name)) {
      problems.push(`${file}:${line}  前端调用了「${name}」（${group} 组），但 ${COMMAND_REGISTRY} 没有注册它`);
    }
  }
  for (const [group, names] of Object.entries(registered)) {
    const excepted = exceptions[group] ?? {};
    for (const name of names) {
      const isUsed = used[group].has(name);
      if (!isUsed && !(name in excepted)) {
        problems.push(
          `${COMMAND_REGISTRY}  「${name}」（${group} 组）已注册，但前端没有调用；确认无用就删掉，仅 e2e 等用的写进 EXCEPTIONS`,
        );
      }
    }
    for (const name of Object.keys(excepted)) {
      if (!names.includes(name)) {
        problems.push(`EXCEPTIONS.${group}  「${name}」已不在 ${COMMAND_REGISTRY} 里注册，删掉这条例外`);
      } else if (used[group].has(name)) {
        problems.push(`EXCEPTIONS.${group}  「${name}」前端已在调用，删掉这条例外`);
      }
    }
  }
  return problems;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !SKIP.some((re) => re.test(path))) yield path;
  }
}

function main() {
  const registry = readFileSync(join(ROOT, COMMAND_REGISTRY), "utf8");
  const registered = Object.fromEntries(GROUPS.map((group) => [group, registeredCommands(registry, group)]));
  const calls = [];
  for (const file of sourceFiles("src")) {
    for (const call of frontendCalls(readFileSync(join(ROOT, file), "utf8"))) calls.push({ ...call, file });
  }
  const problems = findProblems({ registered, calls });
  for (const problem of problems) console.error(problem);
  const total = Object.values(registered).reduce((sum, names) => sum + names.length, 0);
  console.log(
    problems.length === 0
      ? `check-command-names: PASS (${total} 个命令，${calls.length} 处前端调用)`
      : `check-command-names: FAIL ${problems.length} 个问题`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
