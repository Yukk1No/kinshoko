// #78 T18: bind a clean committed source before/after the isolated product build.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const work = resolve("work/t18");
mkdirSync(work, { recursive: true });
const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw Error(result.stderr);
  return result.stdout.trim();
};
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const status = git("status", "--porcelain");
if (status) throw Error("Native product source must be clean: " + status);
const commit = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
const config = resolve("work/t18/tauri.test.json");
const sourceFiles = Object.fromEntries(git("ls-files", "-z").split("\0").filter((path) => /^(\.cargo\/|crates\/|src\/|src-tauri\/|data\/|e2e\/|Cargo\.|package|tsconfig|vite\.|index\.html)/.test(path)).map((path) => [path, hash(path)]));
const input = { commit, tree, clean: true, configSha256: hash(config), sourceFiles };
if (process.argv.includes("--before")) {
  writeFileSync(join(work, "build-input.json"), JSON.stringify(input, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "before-build", commit, tree, sourceFileCount: Object.keys(sourceFiles).length }));
} else {
  const before = JSON.parse(readFileSync(join(work, "build-input.json"), "utf8"));
  if (JSON.stringify(input) !== JSON.stringify(before)) throw Error("Build inputs changed after the clean-source snapshot");
  const destination = join(work, "nativeproof", commit.slice(0, 12));
  mkdirSync(destination, { recursive: true });
  const binary = resolve("target/debug/kinshoko.exe"), preservedBinary = join(destination, "kinshoko.exe");
  copyFileSync(binary, preservedBinary);
  const dll = resolve("target/debug/DirectML.dll");
  if (existsSync(dll)) copyFileSync(dll, join(destination, "DirectML.dll"));
  const files = (root) => readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
  const identifier = "dev.kinshoko.spec78t18test";
  const drivers = { tauri: "C:/Users/yuk1no/.cargo/bin/tauri-driver.exe", edge: "C:/Users/yuk1no/.codex/worktrees/spec78-t01-frontend/kinshoko/work/e2e/tools/msedgedriver.exe" };
  const manifest = {
    ...input, branch: git("branch", "--show-current"), binarySha256: hash(binary), preservedBinary,
    identifier, productName: "Kinshoko T18 Verification", ports: [4618, 4619],
    createdAtUtc: new Date().toISOString(), buildLog: "work/t18/native-build.txt",
    buildCommand: "CARGO_BUILD_JOBS=2 KINSHOKO_SKIP_AUTOSTART=1 node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --config work/t18/tauri.test.json",
    buildConfig: { path: config, sha256: hash(config) },
    distFiles: Object.fromEntries(files("dist").map((path) => [path.replaceAll("\\", "/"), hash(path)])),
    runtime: existsSync(dll) ? { "DirectML.dll": hash(dll) } : {},
    drivers: Object.fromEntries(Object.entries(drivers).map(([name, path]) => [name, { path, sha256: hash(path) }])),
    knownFolderConfig: join(process.env.USERPROFILE, "AppData", "Roaming", identifier, "settings.json"),
    proofRoot: "work/e2e/runtime-capabilities-<timestamp>",
    environment: { KINSHOKO_SKIP_AUTOSTART: "1", CARGO_BUILD_JOBS: "2" },
  };
  writeFileSync(join(work, "native-source.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(destination, "native-source.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ commit, tree, binarySha256: manifest.binarySha256, preservedBinary, sourceFileCount: Object.keys(sourceFiles).length, distFileCount: Object.keys(manifest.distFiles).length, identifier, ports: manifest.ports, knownFolderConfig: manifest.knownFolderConfig }, null, 2));
}
