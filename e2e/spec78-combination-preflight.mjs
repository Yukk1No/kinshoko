// Offline build provenance and read-only preflight for the T20 combined native workflow.
// No process that owns a window starts when this module is imported or a plan is frozen.
import { spawnSync } from "node:child_process";
import { constants, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./spec78-combination-fixture.mjs";
import { checkAttributedBuild } from "./spec78-combination-build.mjs";

export const IDENTIFIER = "dev.kinshoko.spec78t20test";
export const PORT = 4630;
export const text = (file) => readFileSync(file, "utf8").replace(/^\uFEFF/, "");
export const readJson = (file) => JSON.parse(text(file));
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
export function ownedWork(path) {
  const root = resolve(path), base = resolve("work/e2e");
  if (!root.toLowerCase().startsWith((base + sep).toLowerCase()) || !root.includes("spec78-t20")) throw Error("T20 outputs must stay inside this checkout's owned work/e2e directory");
  return root;
}
export function fileRecord(file) {
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw Error(`Missing file: ${path}`);
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}
export function sourceRecord() {
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (dirty) throw Error("Freeze requires a clean checkout, including the tracked harness: " + dirty);
  const source = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]);
  const branch = git(["branch", "--show-current"]);
  // The T20 branch, or its review-fix branch that the merger folds back into it.
  if (!["codex/spec-78-t20", "codex/spec-78-t20-review-fix", "codex/spec-78-finish-local"].includes(branch)) throw Error("Use the assigned T20 branch");
  const files = {};
  for (const path of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (!/^(\.cargo\/|data\/|src\/|src-tauri\/|crates\/|scripts\/|e2e\/|public\/|Cargo\.|package|vite\.|tsconfig|index\.html)/.test(path)) continue;
    const record = fileRecord(path);
    files[path] = { bytes: record.bytes, sha256: record.sha256 };
  }
  return { source, tree, branch, clean: true, files };
}
export function directoryRecord(root) {
  const base = resolve(root), files = {};
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) visit(child);
      else { const record = fileRecord(child); files[relative(base, child).replaceAll("\\", "/")] = { bytes: record.bytes, sha256: record.sha256 }; }
    }
  }
  visit(base);
  if (!files["index.html"]) throw Error("A previously built embedded frontend is required before freezing");
  return { path: base, files };
}
export function sameFiles(expected, actual, label) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const changed = keys.filter(key => expected[key]?.sha256 !== actual[key]?.sha256 || expected[key]?.bytes !== actual[key]?.bytes);
  if (changed.length) throw Error(`${label} changed: ${changed.join(", ")}`);
}
export function isolatedConfig(path) {
  const record = fileRecord(path), config = readJson(path);
  if (config.identifier !== IDENTIFIER || config.productName !== "Kinshoko T20 Combination Probe") throw Error("The config must bind the isolated T20 product");
  if (config.build?.devUrl !== null) throw Error("Native checks require the embedded frontend, with devUrl=null");
  ownedWork(dirname(record.path));
  if (config.build?.beforeBuildCommand !== null || config.build?.beforeDevCommand !== null) throw Error("The attributed build invokes its two recorded commands explicitly; config build hooks must be null");
  // Tauri parses an absolute Windows path ("C:\...") as a URL with scheme "c" and navigates to it.
  // Keep the relative directory form, which Tauri resolves against src-tauri.
  if (typeof config.build?.frontendDist !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(config.build.frontendDist) || resolve("src-tauri", config.build.frontendDist) !== resolve("dist")) throw Error("The isolated config must embed this checkout's exact dist as a relative directory");
  if (config.bundle?.active !== false) throw Error("This native plan must not build or run an installer");
  if (config.plugins?.updater?.pubkey) throw Error("Do not add a production updater key for T20");
  return { ...record, identifier: config.identifier, productName: config.productName };
}
export function python(script, args = []) {
  const result = spawnSync("python", ["-c", script, ...args], { windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
  if (result.status !== 0) throw Error(result.stderr || `Python exited ${result.status}`);
  return JSON.parse(result.stdout);
}
// GetFolderPath and Path.resolve execute independently. APPDATA from a child driver is irrelevant.
export function knownFolderState(identifier = IDENTIFIER) {
  if (![IDENTIFIER, "dev.kinshoko.spec78t19upgrade"].includes(identifier)) throw Error("Only the explicitly isolated test products may be inspected");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$base=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData); Join-Path (Join-Path $base $env:KINSHOKO_T20_IDENTIFIER) 'settings.json' | ConvertTo-Json -Compress"], {
    windowsHide: true, encoding: "utf8", env: { ...process.env, KINSHOKO_T20_IDENTIFIER: identifier },
  });
  if (result.status !== 0) throw Error("KnownFolder resolution failed: " + result.stderr);
  const requested = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
  return python("import pathlib,hashlib,json,sys\np=pathlib.Path(sys.argv[1]); r=p.resolve()\ndef observe(path):\n exists=path.is_file(); data=path.read_bytes() if exists else None\n return {'path':str(path),'exists':exists,'bytes':len(data) if data is not None else None,'sha256':hashlib.sha256(data).hexdigest() if data is not None else None}\nprint(json.dumps({'identifier':sys.argv[2],'requested':observe(p),'resolved':observe(r),'requestedResolvesTo':str(r)}))", [requested, identifier]);
}
export function knownUnchanged(before, after) {
  for (const key of ["requested", "resolved"]) {
    if (before[key].path.toLowerCase() !== after[key].path.toLowerCase() || before[key].exists !== after[key].exists || before[key].sha256 !== after[key].sha256 || before[key].bytes !== after[key].bytes) throw Error(`KnownFolder ${key} changed after preflight`);
  }
}
// After a granted round creates and then removes the test settings, Windows package redirection can
// keep resolving the same requested path into a package LocalCache alias. Accept only that case:
// same requested path, every view absent before and now, and the new alias still names this identifier.
export function knownUnchangedOrAbsentRedirect(before, after) {
  const absent=state=>!state.requested.exists&&!state.resolved.exists;
  if(before.requested.path.toLowerCase()===after.requested.path.toLowerCase()&&absent(before)&&absent(after)&&after.resolved.path.toLowerCase().endsWith((sep+before.identifier+sep+"settings.json").toLowerCase()))return {redirectedWhileAbsent:before.resolved.path.toLowerCase()!==after.resolved.path.toLowerCase()};
  knownUnchanged(before, after);return {redirectedWhileAbsent:false};
}
export function verifyRecord(expected,label) {
  const actual=fileRecord(expected.path);
  if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw Error(label+" changed: "+actual.path);
  return actual;
}
export function sameSnapshot(before,after,label) {
  if(before.source!==after.source||before.tree!==after.tree||before.branch!==after.branch)throw Error(label+" commit/tree changed");
  sameFiles(before.files,after.files,label+" files");
}
export { absentBuildOverrides, rustHost, actualRustToolchain, runBuildCommand, recordAttributedBuild, checkAttributedBuild } from "./spec78-combination-build.mjs";
export function freezeBuild(configPath, output, buildReceiptPath) {
  if(!buildReceiptPath)throw Error("Freeze requires the successful actual build receipt, including command/exit and frozen runtimes");
  const path=resolve(output);ownedWork(dirname(path));
  if(existsSync(path))throw Error("Preserve the existing freeze; select a new output");
  const attributed=checkAttributedBuild(buildReceiptPath),receipt=attributed.receipt,config=isolatedConfig(configPath),source=sourceRecord(),dist=directoryRecord("dist");
  sameSnapshot(receipt.before.source,source,"Source after attributed build");
  sameFiles(receipt.afterNative.dist.files,dist.files,"Attributed embedded frontend");
  if(config.path!==receipt.before.config.path||config.sha256!==receipt.before.config.sha256)throw Error("Freeze config differs from the actual native build config");
  const frozen={kind:"spec78-t20-build-freeze",version:2,at:new Date().toISOString(),...source,config,dist,buildAttribution:attributed.record,application:attributed.application,runtime:attributed.runtime,knownFolder:knownFolderState()};
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(frozen,null,2));return frozen;
}
export function checkFreeze(frozen, allowHarnessRevision = false) {
  if(frozen.kind!=="spec78-t20-build-freeze"||frozen.version!==2)throw Error("Not a T20 freeze with actual build attribution and runtime files");
  verifyRecord(frozen.buildAttribution,"Actual build receipt");
  const attributed=checkAttributedBuild(frozen.buildAttribution.path),built=attributed.receipt.before.source;
  sameSnapshot(built,frozen,"Frozen actual build inputs");
  sameFiles(frozen.dist.files,attributed.receipt.afterNative.dist.files,"Frozen attributed dist");
  if(JSON.stringify(frozen.application)!==JSON.stringify(attributed.application)||JSON.stringify(frozen.runtime)!==JSON.stringify(attributed.runtime))throw Error("Frozen native artifacts differ from their actual build receipt");
  const current=sourceRecord(),changedSource=current.source!==frozen.source||current.tree!==frozen.tree;
  const changes=changedSource?git(["diff","--name-only",frozen.source,current.source]).split("\n").filter(Boolean):[];
  if(changedSource&&!allowHarnessRevision)throw Error("The source differs from the frozen build; record an explicit harness-only observation plan or rebuild");
  const allowed=path=>path.startsWith("e2e/")||path==="docs/implementation/spec-78-t20.md"||path.startsWith("docs/implementation/evidence/spec78-t20/");
  if(changedSource&&changes.some(path=>!allowed(path)))throw Error("A product/source change requires a new build: "+changes.filter(path=>!allowed(path)).join(", "));
  const withoutHarness=files=>Object.fromEntries(Object.entries(files).filter(([path])=>!path.startsWith("e2e/")));
  sameFiles(changedSource?withoutHarness(frozen.files):frozen.files,changedSource?withoutHarness(current.files):current.files,"Tracked build inputs");
  sameFiles(frozen.dist.files,directoryRecord(frozen.dist.path).files,"Embedded frontend");
  if(isolatedConfig(frozen.config.path).sha256!==frozen.config.sha256||frozen.config.sha256!==attributed.receipt.before.config.sha256)throw Error("The exact isolated build config changed");
  return {...current,harnessOnlyChanges:changes};
}
export function checkFixture(fixturePath) {
  const fixture = readJson(fixturePath); ownedWork(fixture.root);
  if (fixture.kind !== "spec78-t20-two-provider-input" || fixture.inputs.virtual?.length !== 144) throw Error("Expected the complete synthetic two-provider fixture");
  if (fileRecord(join(fixture.root,"generator.mjs")).sha256 !== fixture.generatorSha256 || fileRecord(join(fixture.root,"legacy-v16.sql")).sha256 !== fixture.schemaSha256) throw Error("Fixture provenance copies changed");
  for (const [label, input] of Object.entries(fixture.inputs)) for (const record of Array.isArray(input) ? input : [input]) {
    const actual=fileRecord(record.path);
    if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) throw Error("Fixture input changed: " + label);
  }
  if (!fixture.eagle || fixture.inputs.eagleFirst?.width !== 240 || fixture.inputs.eagleNew?.width !== 310) throw Error("Missing reused T14 Eagle inputs");
  for (const label of ["original","itemMetadata","libraryMetadata"]) {
    const expected=fixture.eagle[label],actual=fileRecord(expected.path);ownedWork(dirname(actual.path));
    if(actual.sha256!==expected.sha256||actual.bytes!==expected.bytes)throw Error("Eagle initial input changed: "+label);
  }
  if(fileRecord(fixture.eagle.reusedFrom).sha256!==fixture.eagle.reusedSourceSha256)throw Error("Reused T14 source changed after fixture preparation");
  const equal=fixture.migrationEqualDefault;
  if(!equal||equal.libraryId!==fixture.b.info.id||equal.localTagId!==fixture.b.tags.parted_hair||fileRecord(equal.defaultsSource).sha256!==equal.defaultsSourceSha256||readJson(equal.defaultsSource).entries.find(entry=>entry.external===equal.external)?.names["zh-CN"]!==equal.name)throw Error("The unused fixture must force B's old name equal to the actual installed bundled default");
  for (const library of [fixture.a, fixture.b]) {
    if (fileRecord(join(library.info.root, "library.sqlite")).sha256 !== library.databaseInputSha256) throw Error("Fixture database was used or changed before the native round");
    if (fileRecord(library.original).sha256 !== fixture.inputs.old.sha256) throw Error("Legacy original changed");
  }
  return fixture;
}
export function makeNativePlan({ freezePath, application, edgeDriver, tauriDriver, fixturePath, output, allowHarnessRevision = false }) {
  const frozen=readJson(freezePath),observation=checkFreeze(frozen,allowHarnessRevision);
  const file=resolve(output);ownedWork(dirname(file));
  if(existsSync(file))throw Error("Native plan already exists; retain it and choose a new round");
  knownUnchangedOrAbsentRedirect(frozen.knownFolder,knownFolderState());
  const fixtureFile=fileRecord(fixturePath);checkFixture(fixturePath);
  const exe=verifyRecord(frozen.application,"Attributed frozen executable");
  if(application&&resolve(application)!==exe.path)throw Error("The plan must run the exact frozen executable from the attributed build");
  const plan={kind:"spec78-t20-native-plan",version:2,at:new Date().toISOString(),freeze:fileRecord(freezePath),build:frozen,observation,allowHarnessRevision,application:exe,runtime:frozen.runtime,edgeDriver:fileRecord(edgeDriver),tauriDriver:fileRecord(tauriDriver),fixture:fixtureFile,port:PORT,knownFolder:knownFolderState(),scope:"two-provider-continuous-workflow",nativeExecuted:false,desktopGrant:null};
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(plan,null,2));return plan;
}
export function checkNativePlan(plan) {
  if(plan.kind!=="spec78-t20-native-plan"||plan.version!==2||plan.port!==PORT||plan.nativeExecuted!==false)throw Error("Not an unused T20 native plan with actual build attribution");
  verifyRecord(plan.freeze,"Frozen build record");
  const observation=checkFreeze(plan.build,plan.allowHarnessRevision===true);
  if(observation.source!==plan.observation.source||observation.tree!==plan.observation.tree)throw Error("The clean observation source changed after its explicit plan");
  sameFiles(plan.observation.files,observation.files,"Actual observation and harness inputs");
  if(JSON.stringify(observation.harnessOnlyChanges)!==JSON.stringify(plan.observation.harnessOnlyChanges))throw Error("The recorded harness-only change list changed");
  if(JSON.stringify(plan.application)!==JSON.stringify(plan.build.application)||JSON.stringify(plan.runtime)!==JSON.stringify(plan.build.runtime))throw Error("Native plan artifacts differ from the actual frozen build");
  for(const key of ["application","edgeDriver","tauriDriver","fixture"])verifyRecord(plan[key],"Native plan "+key);
  for(const [name,record] of Object.entries(plan.runtime))verifyRecord(record,"Native plan runtime "+name);
  knownUnchanged(plan.knownFolder,knownFolderState());return checkFixture(plan.fixture.path);
}
// These functions are only called inside a granted native lifecycle. They preserve this identifier alone.
export { preserveKnownFolder, restoreKnownFolder, clearKnownFolderForBlank } from "./spec78-combination-known-folder.mjs";
