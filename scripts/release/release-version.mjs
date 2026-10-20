// 发布版本号的规则，由 .github/workflows/prepare-release.yml 与 tag-release.yml 调用。
//
// 用法：node scripts/release/release-version.mjs <prepare|tag> <版本> <分支> [当前版本]
// 合规时退出码 0；否则把原因写到标准错误，退出码 1。
//
// 版本号按 SemVer（docs/agents/issue-tracker.md 的 Milestones and versions）：测试版 1.0.0-beta.1、
// 候选版 1.0.0-rc.1、正式版 1.0.0。所有改版本号的 PR 都开到开发主干 integration/v1（AGENTS.md）；
// 测试版、候选版在 integration/v1 上打标签，正式版随 PR #71 合进 main 后在 main 上打标签。
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

/**
 * 不能在 `branch` 上对 `version` 做 `step`（`prepare` 改版本号、`tag` 打标签）的原因；能做时为 `null`。
 * `current` 是改之前的版本，读得出时要求新版本更大。
 */
export function releaseProblem({ step, version, branch, current }) {
  if (!parse(version)) {
    return `版本号“${version}”格式不对：应为 1.0.0、1.0.0-beta.1、1.0.0-rc.1 这样，不带 v。`;
  }
  const prerelease = version.includes("-");
  if (step === "prepare" && branch !== TRUNK) {
    return `版本号在 ${TRUNK} 上准备（正式版之后经 PR #71 进 ${STABLE}），不能在 ${branch} 上准备。`;
  }
  if (step === "tag" && prerelease && branch !== TRUNK) return `测试版和候选版在 ${TRUNK} 上打标签，不在 ${branch} 上打。`;
  if (step === "tag" && !prerelease && branch !== STABLE) return `正式版合进 ${STABLE} 后才打标签，不在 ${branch} 上打。`;
  if (current && parse(current) && compareVersions(version, current) <= 0) {
    return `新版本号 ${version} 不大于当前的 ${current}。`;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [step, version, branch, current] = process.argv.slice(2);
  if (!["prepare", "tag"].includes(step) || !branch) {
    console.error("用法：node scripts/release/release-version.mjs <prepare|tag> <版本> <分支> [当前版本]");
    process.exit(2);
  }
  const problem = releaseProblem({ step, version, branch, current });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
