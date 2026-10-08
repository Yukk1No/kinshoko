// 还原度门槛实验的无人值守运行（#45）：kinshoko.exe --fidelity-gate <报告目录> --exit。
//
// 用法：node e2e/fidelity-gate.mjs <kinshoko.exe> [报告目录]
// 程序在报告目录下生成样本资料库，由 WebView2 解码原图与缩略图比较色块 ΔE2000，保存 JSON 与
// Markdown 报告后退出；退出码 0 表示全部门槛样本通过。画师电脑上不带 --exit 运行，填写 HDR 与
// 自动色彩管理状态后手动保存。

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , appArg, reportArg] = process.argv;
if (!appArg) {
  console.error("用法：node e2e/fidelity-gate.mjs <kinshoko.exe> [报告目录]");
  process.exit(2);
}
const reportDir = resolve(reportArg ?? mkdtempSync(join(tmpdir(), "kinshoko-fidelity-")));
mkdirSync(reportDir, { recursive: true });
const TIMEOUT_MS = 5 * 60 * 1000;

const child = spawn(resolve(appArg), ["--fidelity-gate", reportDir, "--exit"], {
  stdio: "inherit",
  env: { ...process.env, KINSHOKO_SKIP_AUTOSTART: "1", KINSHOKO_DATA_DIR: join(reportDir, "app-data") },
});
const timer = setTimeout(() => {
  console.error(`门槛实验 ${TIMEOUT_MS / 1000} 秒内没有结束`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

child.on("exit", (code) => {
  clearTimeout(timer);
  const md = readdirSync(reportDir).filter((f) => /^fidelity-report-.*\.md$/.test(f));
  if (md.length === 0) {
    console.error(`没有生成报告（退出码 ${code}）`);
    process.exit(1);
  }
  console.log(readFileSync(join(reportDir, md.sort().at(-1)), "utf8"));
  console.log(`报告目录：${reportDir}`);
  process.exit(code ?? 1);
});
