// 测试版更新通道（#204）：发布一个 Release 后，决定要不要把它的 latest.json 复制到固定的预发布
// Release `channel-beta`。由 .github/workflows/beta-channel.yml 调用。
//
// 用法：node scripts/release/beta-channel.mjs <标签> <owner/repo> <发布的 latest.json> [通道现有的 latest.json]
// 要更新时退出码 0 并在标准输出写 `update=true`；不更新时写 `update=false`；清单不对时把原因写到标准错误，退出码 1。
// 原因同时写到标准错误，工作流把它记进日志。
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CHANNEL_TAG = "channel-beta";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(version) {
  const m = SEMVER.exec(version ?? "");
  if (!m) throw new Error(`版本号不是 semver：${version}`);
  return { core: m.slice(1, 4).map(Number), pre: m[4] === undefined ? [] : m[4].split(".") };
}

/** SemVer 2.0 的先后：负数表示 a 较旧。预发布低于同号正式版，纯数字的标识按数字比。 */
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/** 发布的清单必须是这个标签的版本，安装包在原仓库这个版本的 Release 里，并带签名。 */
function validate(tag, manifest, repo) {
  if (manifest?.version === undefined || `v${manifest.version}` !== tag) {
    throw new Error(`latest.json 的版本 ${manifest?.version} 与标签 ${tag} 不一致。`);
  }
  parse(manifest.version);
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  for (const name of ["windows-x86_64-nsis", "windows-x86_64"]) {
    const platform = manifest.platforms?.[name];
    if (!platform?.url?.startsWith(prefix)) {
      throw new Error(`latest.json 的 ${name} 安装包地址不在 ${prefix} 下：${platform?.url}`);
    }
    if (typeof platform.signature !== "string" || platform.signature.trim() === "") {
      throw new Error(`latest.json 的 ${name} 没有更新签名。`);
    }
  }
}

/**
 * 测试版通道收测试版、候选版和正式版中最新的：发布的版本不比通道里的旧就写入（同一版本重跑照样覆盖）。
 * 比通道里的旧（例如测试新版期间补发旧系列的修复版）时不动通道。
 */
export function planBetaChannel({ tag, published, current, repo }) {
  if (tag === CHANNEL_TAG) return { update: false, reason: `${CHANNEL_TAG} 是测试版通道本身，不处理。` };
  validate(tag, published, repo);
  const version = published.version;
  if (current === null) {
    return { update: true, version, reason: `测试版通道还没有 latest.json，写入 ${version}。` };
  }
  if (compareVersions(version, current.version) < 0) {
    return { update: false, version, reason: `测试版通道已是更新的 ${current.version}，${version} 不写入。` };
  }
  return { update: true, version, reason: `测试版通道从 ${current.version} 更新到 ${version}。` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [tag, repo, publishedPath, currentPath] = process.argv.slice(2);
  if (!publishedPath && tag !== CHANNEL_TAG) {
    console.error("用法：node scripts/release/beta-channel.mjs <标签> <owner/repo> <发布的 latest.json> [通道现有的 latest.json]");
    process.exit(2);
  }
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  try {
    const plan = planBetaChannel({
      tag,
      repo,
      published: tag === CHANNEL_TAG ? null : read(publishedPath),
      current: currentPath && existsSync(currentPath) ? read(currentPath) : null,
    });
    console.error(plan.reason);
    console.log(`update=${plan.update}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
