// 发布版本号的规则，由 .github/workflows/prepare-release.yml 与 tag-release.yml 调用。
//
// 用法：node scripts/release/release-version.mjs <版本> <分支> [当前版本]
// 合规时退出码 0；否则把原因写到标准错误，退出码 1。
//
// 版本号按 SemVer（docs/agents/issue-tracker.md 的 Milestones and versions）：测试版 1.0.0-beta.1、
// 候选版 1.0.0-rc.1 从开发主干 integration/v1 发；正式版 1.0.0 从 main 发（AGENTS.md：main 只经 PR #71 接收 v1）。
import { pathToFileURL } from "node:url";

const FORMAT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/;
const STAGES = ["alpha", "beta", "rc"];
const TRUNK = "integration/v1";
const STABLE = "main";

function parse(version) {
  const m = FORMAT.exec(version);
  if (!m) return null;
  const [, major, minor, patch, stage, n] = m;
  // 没有预发布后缀的排在同一主体的所有预发布之后。
  return [major, minor, patch].map(Number).concat(stage ? [STAGES.indexOf(stage), Number(n)] : [STAGES.length, 0]);
}

/** 正数：a 更新；负数：b 更新；0：相同。两者都须合规。 */
export function compareVersions(a, b) {
  const [x, y] = [parse(a), parse(b)];
  const i = x.findIndex((d, k) => d !== y[k]);
  return i < 0 ? 0 : x[i] - y[i];
}

/** 不能从 `branch` 发 `version` 的原因；能发时为 `null`。给了 `current` 时还要求新版本更大。 */
export function releaseProblem({ version, branch, current }) {
  if (!parse(version)) {
    return `版本号“${version}”格式不对：应为 1.0.0、1.0.0-beta.1、1.0.0-rc.1 这样，不带 v。`;
  }
  const prerelease = version.includes("-");
  if (prerelease && branch !== TRUNK) return `测试版和候选版从 ${TRUNK} 发，不能从 ${branch} 发。`;
  if (!prerelease && branch !== STABLE) return `正式版从 ${STABLE} 发，不能从 ${branch} 发。`;
  if (current !== undefined && parse(current) && compareVersions(version, current) <= 0) {
    return `新版本号 ${version} 不大于当前的 ${current}。`;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, branch, current] = process.argv.slice(2);
  if (!branch) {
    console.error("用法：node scripts/release/release-version.mjs <版本> <分支> [当前版本]");
    process.exit(2);
  }
  const problem = releaseProblem({ version, branch, current });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
