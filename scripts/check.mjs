#!/usr/bin/env node
// 要报告“检查是否通过”时用的命令（npm run check）。每一步的结论只取决于它的退出码和实际跑了多少用例，
// 所以 vitest 用例全过却因未处理错误失败、测试目标不存在、过滤后一条没跑，都会让命令以非零退出。
//
//   npm run check                        typecheck + 命令名对照 + biome check + vitest
//   npm run check -- --rust              再加 cargo fmt --check、clippy、nextest（core）
//   npm run check -- --rust-only         只跑 Rust 这三步
//   npm run check -- App.import          只跑 vitest，参数原样透传
//   npm run check -- --rust-only --test integration tag_catalog::   只跑 nextest，参数原样透传
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_HEAD_LINES = 120;
const MAX_TAIL_LINES = 30;

export function parseArgs(argv) {
  const rust = argv.includes("--rust");
  const rustOnly = argv.includes("--rust-only");
  const passthrough = argv.filter((arg) => arg !== "--rust" && arg !== "--rust-only");
  if (rust && rustOnly) return { error: "--rust and --rust-only are mutually exclusive" };
  if (rust && passthrough.length > 0) {
    return {
      error:
        "--rust runs everything, so a filter has no single target: " +
        "pass filters alone (vitest) or with --rust-only (nextest)",
    };
  }
  return { rust, rustOnly, passthrough };
}

const tsc = (args) => ({ command: process.execPath, args: ["node_modules/typescript/bin/tsc", ...args] });
const vitest = (args) => ({
  command: process.execPath,
  args: ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot", "--silent=passed-only", ...args],
});
const cargo = (args) => ({ command: "cargo", args });
const biome = (args) => ({ command: process.execPath, args: ["node_modules/@biomejs/biome/bin/biome", ...args] });

const STEP = {
  typecheck: () => ({ name: "typecheck", ...tsc(["--noEmit"]) }),
  commandNames: () => ({
    name: "command names",
    command: process.execPath,
    args: ["scripts/check-command-names.mjs"],
  }),
  // biome.json 里开的规则，加上 src、scripts、e2e 的格式（#523）。
  lint: () => ({ name: "biome check", ...biome(["check", "--colors=off"]) }),
  vitest: (args) => ({ name: "vitest", kind: "vitest", ...vitest(args) }),
  frontend: () => ({
    name: "vite build (clippy needs dist/)",
    command: process.execPath,
    args: ["node_modules/vite/bin/vite.js", "build"],
  }),
  fmt: () => ({ name: "cargo fmt", ...cargo(["fmt", "--all", "--check"]) }),
  clippy: () => ({
    name: "clippy",
    ...cargo(["clippy", "--quiet", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]),
  }),
  nextest: (args) => ({
    name: "nextest (kinshoko-core)",
    kind: "nextest",
    ...cargo([
      "nextest",
      "run",
      "-p",
      "kinshoko-core",
      "--locked",
      "--cargo-quiet",
      "--no-fail-fast",
      "--hide-progress-bar",
      "--status-level=fail",
      "--final-status-level=fail",
      "--failure-output=final",
      ...args,
    ]),
  }),
};

// 有过滤参数时只跑对应的测试：这是开发中的快速回路，汇总会写明其余检查没跑。
export function planSteps({ rust, rustOnly, passthrough }, { hasDist = true } = {}) {
  if (passthrough.length > 0) {
    return [rustOnly ? STEP.nextest(passthrough) : STEP.vitest(passthrough)];
  }
  const steps = rustOnly ? [] : [STEP.typecheck(), STEP.commandNames(), STEP.lint(), STEP.vitest([])];
  if (rust || rustOnly) {
    steps.push(STEP.fmt());
    if (!hasDist) steps.push(STEP.frontend());
    steps.push(STEP.clippy(), STEP.nextest([]));
  }
  return steps;
}

// 读数改版时取不到结果，evaluate 会判失败，不会误报通过。
export function testCounts(kind, output) {
  if (kind === "vitest") {
    const tests = output.match(/^\s*Tests\s+(.+)$/m);
    if (!tests) return null;
    const errors = output.match(/^\s*Errors\s+(.+)$/m);
    return {
      summary: errors ? `${tests[1].trim()}, ${errors[1].trim()}` : tests[1].trim(),
      passed: Number(tests[1].match(/(\d+) passed/)?.[1] ?? 0),
    };
  }
  const lines = [...output.matchAll(/^\s*Summary \[[^\]]*\]\s+(.+)$/gm)];
  if (lines.length === 0) return null;
  const summary = lines[lines.length - 1][1].trim();
  return { summary, passed: Number(summary.match(/(\d+) passed/)?.[1] ?? 0) };
}

export function evaluate({ kind, status, output }) {
  const counts = kind ? testCounts(kind, output) : null;
  if (status !== 0) {
    const how = status === null ? "killed or failed to start" : `exit code ${status}`;
    return { ok: false, note: counts ? `${how}; ${counts.summary}` : how };
  }
  if (!kind) return { ok: true, note: "" };
  if (!counts) return { ok: false, note: "exit code 0, but no test summary in the output" };
  if (counts.passed === 0) return { ok: false, note: `exit code 0, but no test passed: ${counts.summary}` };
  return { ok: true, note: counts.summary };
}

const DETAIL_START = {
  vitest: /Failed Suites|Failed Tests|Unhandled (Error|Rejection)|Vitest caught/,
  nextest: /^\s*Summary \[/,
};

export function failureDetail(kind, output, logPath) {
  let lines = output.trimEnd().split(/\r?\n/);
  const start = kind ? lines.findIndex((line) => DETAIL_START[kind].test(line)) : -1;
  if (start > 0) lines = lines.slice(start);
  if (lines.length <= MAX_HEAD_LINES + MAX_TAIL_LINES) return lines.join("\n");
  const omitted = lines.length - MAX_HEAD_LINES - MAX_TAIL_LINES;
  return [
    ...lines.slice(0, MAX_HEAD_LINES),
    `... ${omitted} lines omitted, full log: ${logPath}`,
    ...lines.slice(-MAX_TAIL_LINES),
  ].join("\n");
}

function run(step, logDir, index) {
  const logPath = join(logDir, `${index}.log`);
  const log = openSync(logPath, "w");
  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: ["ignore", log, log],
    env: { ...process.env, NO_COLOR: "1", CARGO_TERM_COLOR: "never", FORCE_COLOR: "0" },
  });
  closeSync(log);
  const output = readFileSync(logPath, "utf8") + (result.error ? `\n${result.error.message}` : "");
  return {
    ...evaluate({ kind: step.kind, status: result.error ? null : result.status, output }),
    output,
    logPath,
    seconds: ((Date.now() - started) / 1000).toFixed(1),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    console.error(`check: ${options.error}`);
    return 2;
  }
  const steps = planSteps(options, { hasDist: existsSync(join(ROOT, "dist/index.html")) });
  const logDir = mkdtempSync(join(tmpdir(), "kinshoko-check-"));
  const results = steps.map((step, index) => {
    const result = run(step, logDir, index);
    const note = result.note ? ` - ${result.note}` : "";
    console.log(`${result.ok ? "PASS" : "FAIL"} ${step.name} (${result.seconds}s)${note}`);
    if (!result.ok) console.log(`\n${failureDetail(step.kind, result.output, result.logPath)}\n`);
    return result;
  });

  const failed = results.filter((result) => !result.ok).length;
  if (failed === 0) rmSync(logDir, { recursive: true, force: true });
  const scope = options.passthrough.length > 0 ? "filtered run, other checks did not run" : "all planned checks ran";
  const rustScope = options.rust || options.rustOnly ? "" : ", Rust not checked (add --rust)";
  console.log(
    failed === 0
      ? `check: PASS ${results.length}/${results.length} (${scope}${rustScope})`
      : `check: FAIL ${failed}/${results.length} failed (${scope}${rustScope}), logs: ${logDir}`,
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
