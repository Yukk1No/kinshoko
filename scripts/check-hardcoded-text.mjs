// 找出前端组件与 Rust 代码里写死的中文（#359）：界面文字应放在 i18n 资源里
// （前端 src/i18n/locales，Rust 侧 src-tauri/src/ui_text.rs）。注释、测试与资源文件不查。
//
// 用法：node scripts/check-hardcoded-text.mjs [--mode warn|fail] [--diff-base <git 引用>]
//   --mode 默认取环境变量 KINSHOKO_HARDCODED_TEXT_MODE，再默认 warn。warn 只报告、退出码为 0；
//          fail 有命中时退出码为 1。
//   --diff-base 给出时，相对这个引用新增的行另列在前面（PR 里用 HEAD^1，即合并提交的 base 一侧）。
// 在 GitHub Actions 里运行时，命中行同时输出为 warning/error 注解，新增的行排在前面。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** 要查的目录与扩展名。 */
const ROOTS = [
  { dir: "src", exts: [".ts", ".tsx"] },
  { dir: "src-tauri/src", exts: [".rs"] },
  { dir: "crates", exts: [".rs"] },
];

/** 不查的路径（相对仓库根、用 / 分隔）：资源文件、生成物、测试与开发用工具。 */
const SKIP = [
  /^src\/i18n\/locales\//,
  /^src\/bindings\//,
  /^src\/test\//,
  /\.test\.tsx?$/,
  /\.fixtures\.tsx?$/,
  /^src-tauri\/src\/ui_text\.rs$/,
  /(^|\/)tests\//,
  /(^|\/)examples\//,
  /(^|\/)benches\//,
  /(^|\/)tests?\.rs$/,
  /_tests?\.rs$/,
];

export function isSkipped(path) {
  return SKIP.some(re => re.test(path));
}

/**
 * 把注释换成空格（保留换行，行号不变）。返回两份文本：
 * code 保留字符串内容，用来找中文；shape 连字符串内容也抹掉，用来数括号。
 * 两份文本按 UTF-16 码元逐个对齐，下标可以互用。
 */
export function stripComments(text, lang) {
  let code = "";
  let shape = "";
  const blank = ch => (ch === "\n" ? "\n" : " ".repeat(ch.length));
  const keep = (ch, inString) => {
    code += ch;
    shape += inString ? blank(ch) : ch;
  };
  const drop = ch => {
    code += blank(ch);
    shape += blank(ch);
  };
  // 模板字符串里 ${ } 可以嵌套：栈里记着每层 ${ 进入时的花括号深度。
  const templateStack = [];
  let braceDepth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") drop(text[i++]);
      continue;
    }
    if (ch === "/" && next === "*") {
      // Rust 的块注释可以嵌套，TS 的不行。
      let depth = 0;
      while (i < n) {
        if (text[i] === "/" && text[i + 1] === "*" && (lang === "rs" || depth === 0)) {
          depth++;
          drop(text[i++]);
          drop(text[i++]);
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          drop(text[i++]);
          drop(text[i++]);
          if (depth === 0) break;
        } else drop(text[i++]);
      }
      continue;
    }
    if (lang === "ts" && ch === "/" && regexCanStart(shape)) {
      // 正则字面量：里面的 /* 或 // 不是注释。到不在字符类里、没转义的 / 为止，不跨行。
      let inClass = false;
      keep(text[i++], false);
      while (i < n && text[i] !== "\n") {
        const c = text[i];
        if (c === "\\") {
          keep(c, true);
          if (i + 1 < n && text[i + 1] !== "\n") keep(text[++i], true);
          i++;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        keep(c, true);
        i++;
      }
      if (text[i] === "/") keep(text[i++], false);
      continue;
    }
    if (lang === "rs" && ch === "r" && (next === '"' || next === "#") && !/[\w]/.test(text[i - 1] ?? "")) {
      // 原始字符串 r"…"、r#"…"#
      let j = i + 1;
      let hashes = 0;
      while (text[j] === "#") { hashes++; j++; }
      if (text[j] === '"') {
        const close = '"' + "#".repeat(hashes);
        const end = text.indexOf(close, j + 1);
        const stop = end === -1 ? n : end + close.length;
        for (let k = i; k < j + 1; k++) keep(text[k], false);
        for (let k = j + 1; k < stop; k++) keep(text[k], k < stop - close.length);
        i = stop;
        continue;
      }
    }
    if (lang === "rs" && ch === "'") {
      // 字符字面量 '中'、'\n'，否则是生命周期 'a。
      const m = /^'(\\.[^']*|[^'\\])'/su.exec(text.slice(i, i + 12));
      if (m) {
        for (const c of m[0]) keep(c, true);
        i += m[0].length;
        continue;
      }
      keep(ch, false);
      i++;
      continue;
    }
    if (ch === '"' || (lang === "ts" && (ch === "'" || ch === "`"))) {
      keep(ch, false);
      i++;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          keep(c, true);
          if (i + 1 < n) keep(text[i + 1], true);
          i += 2;
          continue;
        }
        if (c === ch) {
          keep(c, false);
          i++;
          break;
        }
        if (ch === "`" && c === "$" && text[i + 1] === "{") {
          keep(c, false);
          keep("{", false);
          i += 2;
          templateStack.push(braceDepth);
          braceDepth++;
          break;
        }
        // TS 的单双引号字符串不跨行；JSX 文本里的撇号（It's）也到行尾为止，不会吞掉后面的行。
        if (lang === "ts" && ch !== "`" && c === "\n") break;
        keep(c, true);
        i++;
      }
      continue;
    }
    if (lang === "ts" && ch === "{") braceDepth++;
    if (lang === "ts" && ch === "}") {
      braceDepth--;
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        // 回到模板字符串里：伪造一个 ` 接着扫，借用上面的字符串分支。
        templateStack.pop();
        keep(ch, false);
        i++;
        const rest = scanTemplateTail(text, i, keep);
        i = rest.index;
        if (rest.reentered) {
          templateStack.push(braceDepth);
          braceDepth++;
        }
        continue;
      }
    }
    keep(ch, false);
    i++;
  }
  return { code, shape };
}

/**
 * 这里的 / 是正则开头还是除号：看前面最后一个有意义的记号。
 * 不把 < 算进去，免得 JSX 的 </p> 被当成正则。
 */
function regexCanStart(shape) {
  let end = shape.length;
  while (end > 0 && /\s/.test(shape[end - 1])) end--;
  if (end === 0) return true;
  const before = shape.slice(Math.max(0, end - 8), end);
  if (/[(,=:[!&|?{};+\-*%~^]$/.test(before)) return true;
  return /\b(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(before);
}

/** 从 ${ } 的 } 后面接着扫模板字符串，到 ` 或下一个 ${ 为止。 */
function scanTemplateTail(text, i, keep) {
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      keep(c, true);
      if (i + 1 < n) keep(text[i + 1], true);
      i += 2;
      continue;
    }
    if (c === "`") {
      keep(c, false);
      return { index: i + 1, reentered: false };
    }
    if (c === "$" && text[i + 1] === "{") {
      keep(c, false);
      keep("{", false);
      return { index: i + 2, reentered: true };
    }
    keep(c, true);
    i++;
  }
  return { index: i, reentered: false };
}

/** Rust 里 #[cfg(test)] 标着的条目所占的行（从 1 数），整条跳过。 */
export function rustTestLines(shape) {
  const lines = new Set();
  const attr = /#\[cfg\(\s*test\s*\)\]/g;
  let m;
  while ((m = attr.exec(shape))) {
    let i = m.index + m[0].length;
    // 条目到第一个 ; 为止，或者到第一个 { 配对的 } 为止。
    while (i < shape.length && shape[i] !== ";" && shape[i] !== "{") i++;
    if (shape[i] === "{") {
      let depth = 0;
      for (; i < shape.length; i++) {
        if (shape[i] === "{") depth++;
        else if (shape[i] === "}" && --depth === 0) break;
      }
    }
    const first = lineOf(shape, m.index);
    const last = lineOf(shape, i);
    for (let l = first; l <= last; l++) lines.add(l);
    attr.lastIndex = Math.max(attr.lastIndex, i);
  }
  return lines;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Rust 里只给开发者看的文字：panic 一类宏与 expect 的消息、打到控制台的输出。
 * 这些调用的整个参数列表换成空格。
 */
const RUST_DEVELOPER_TEXT =
  /(?:\.expect|\b(?:panic|unreachable|todo|unimplemented|(?:debug_)?assert(?:_eq|_ne)?|e?print(?:ln)?)!)\s*\(/g;

export function maskRustDeveloperText(code, shape) {
  const out = code.split("");
  for (const m of shape.matchAll(RUST_DEVELOPER_TEXT)) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let i = start;
    for (; i < shape.length; i++) {
      if (shape[i] === "(") depth++;
      else if (shape[i] === ")" && --depth === 0) break;
    }
    for (let k = start; k <= i && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  }
  return out.join("");
}

/** 一个文件里写死中文的行：[{ line, text }]。 */
export function findHardcodedText(text, path) {
  const lang = path.endsWith(".rs") ? "rs" : "ts";
  const stripped = stripComments(text.replace(/\r\n/g, "\n"), lang);
  const shape = stripped.shape;
  const code = lang === "rs" ? maskRustDeveloperText(stripped.code, shape) : stripped.code;
  const skipped = lang === "rs" ? rustTestLines(shape) : new Set();
  const original = text.replace(/\r\n/g, "\n").split("\n");
  const hits = [];
  code.split("\n").forEach((line, index) => {
    if (CJK.test(line) && !skipped.has(index + 1)) {
      hits.push({ line: index + 1, text: original[index].trim() });
    }
  });
  return hits;
}

function listFiles(root, dir, exts) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      out.push(...listFiles(root, path, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext)) && !isSkipped(path)) {
      out.push(path);
    }
  }
  return out;
}

/** 相对 base 新增的行：Map<路径, Set<行号>>。 */
function addedLines(root, base) {
  const diff = execFileSync("git", ["diff", "--unified=0", "--no-color", "--no-renames", base, "--", ...ROOTS.map(r => r.dir)], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const added = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      if (file && !added.has(file)) added.set(file, new Set());
    } else if (file && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let l = start; l < start + count; l++) added.get(file).add(l);
    }
  }
  return added;
}

function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function parseArgs(argv) {
  const options = { mode: process.env.KINSHOKO_HARDCODED_TEXT_MODE || "warn", diffBase: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") options.mode = argv[++i];
    else if (argv[i] === "--diff-base") options.diffBase = argv[++i];
    else throw new Error(`不认识的参数：${argv[i]}`);
  }
  if (options.mode !== "warn" && options.mode !== "fail") {
    throw new Error(`--mode 只能是 warn 或 fail，收到 ${options.mode}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const added = options.diffBase ? addedLines(root, options.diffBase) : new Map();
  const hits = [];
  for (const { dir, exts } of ROOTS) {
    for (const path of listFiles(root, dir, exts)) {
      const text = readFileSync(join(root, path), "utf8");
      for (const hit of findHardcodedText(text, path)) {
        hits.push({ path, ...hit, added: added.get(path)?.has(hit.line) ?? false });
      }
    }
  }
  hits.sort((a, b) => Number(b.added) - Number(a.added));

  const level = options.mode === "fail" ? "error" : "warning";
  const inActions = process.env.GITHUB_ACTIONS === "true";
  const newCount = hits.filter(h => h.added).length;
  for (const hit of hits) {
    const tag = hit.added ? "（新增）" : "";
    if (inActions) {
      const title = hit.added ? "新增的硬编码中文" : "硬编码中文";
      console.log(`::${level} file=${escapeProperty(hit.path)},line=${hit.line},title=${escapeProperty(title)}::${escapeData(hit.text)}`);
    } else {
      console.log(`${hit.path}:${hit.line}${tag}  ${hit.text}`);
    }
  }
  const summary = hits.length === 0
    ? "没有发现写死的中文。"
    : `发现 ${hits.length} 行写死的中文${options.diffBase ? `，其中 ${newCount} 行是这次新增的` : ""}。界面文字请放进 i18n 资源（src/i18n/locales，Rust 侧 src-tauri/src/ui_text.rs）。`;
  console.log(summary);
  if (hits.length > 0 && options.mode === "fail") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
