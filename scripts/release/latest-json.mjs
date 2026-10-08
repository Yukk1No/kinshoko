// 生成 Tauri updater 读取的更新清单 latest.json（#70），由 .github/workflows/release.yml 调用。
//
// 用法：node scripts/release/latest-json.mjs <版本> <安装包路径> <签名文件路径> <owner/repo> <输出路径>
// 安装包下载地址按 GitHub Releases 的规则拼成 https://github.com/<repo>/releases/download/v<版本>/<文件名>。
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 更新清单。Windows 上 updater 先找 `windows-x86_64-nsis`，再找 `windows-x86_64`，两个都写。
 * `signature` 是 `tauri build` 生成的 .sig 文件的全文（minisign 签名的 base64）。
 */
export function latestJson({ version, signature, repo, installer, pubDate, notes = "" }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`版本号不是 semver：${version}`);
  }
  const sig = signature.trim();
  if (sig === "") throw new Error("签名为空：确认构建时设置了 TAURI_SIGNING_PRIVATE_KEY");
  const url = `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(installer)}`;
  const platform = { signature: sig, url };
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64-nsis": platform,
      "windows-x86_64": platform,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, installerPath, sigPath, repo, out] = process.argv.slice(2);
  if (!out) {
    console.error("用法：node scripts/release/latest-json.mjs <版本> <安装包> <签名> <owner/repo> <输出>");
    process.exit(2);
  }
  const manifest = latestJson({
    version,
    signature: readFileSync(sigPath, "utf8"),
    repo,
    installer: basename(installerPath),
    pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已写入 ${out}`);
}
