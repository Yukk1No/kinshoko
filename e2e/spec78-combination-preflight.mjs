// Offline build provenance and read-only preflight for the T20 combined native workflow.
// No process that owns a window starts when this module is imported or a plan is frozen.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./spec78-combination-fixture.mjs";

export const IDENTIFIER = "dev.kinshoko.spec78t20test";
export const PORT = 4630;
const text = (file) => readFileSync(file, "utf8").replace(/^\uFEFF/, "");
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
  if (branch !== "codex/spec-78-t20") throw Error("Use the assigned T20 branch");
  const files = {};
  for (const path of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (!/^(src\/|src-tauri\/|crates\/|scripts\/|e2e\/|public\/|Cargo\.|package|vite\.|tsconfig|index\.html)/.test(path)) continue;
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
function sameFiles(expected, actual, label) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const changed = keys.filter(key => expected[key]?.sha256 !== actual[key]?.sha256 || expected[key]?.bytes !== actual[key]?.bytes);
  if (changed.length) throw Error(`${label} changed: ${changed.join(", ")}`);
}
export function isolatedConfig(path) {
  const record = fileRecord(path), config = readJson(path);
  if (config.identifier !== IDENTIFIER || config.productName !== "Kinshoko T20 Combination Probe") throw Error("The config must bind the isolated T20 product");
  if (config.build?.devUrl !== null) throw Error("Native checks require the embedded frontend, with devUrl=null");
  if (config.build?.beforeBuildCommand) throw Error("Freeze the freshly built frontend first; this config must not rebuild it after the dist hash is frozen");
  if (config.bundle?.active !== false) throw Error("This native plan must not build or run an installer");
  if (config.plugins?.updater?.pubkey) throw Error("Do not add a production updater key for T20");
  return { ...record, identifier: config.identifier, productName: config.productName };
}
function python(script, args = []) {
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
function knownUnchanged(before, after) {
  for (const key of ["requested", "resolved"]) {
    if (before[key].path.toLowerCase() !== after[key].path.toLowerCase() || before[key].exists !== after[key].exists || before[key].sha256 !== after[key].sha256 || before[key].bytes !== after[key].bytes) throw Error(`KnownFolder ${key} changed after preflight`);
  }
}
export function freezeBuild(configPath, output) {
  const path = resolve(output); ownedWork(dirname(path));
  if (existsSync(path)) throw Error("Preserve the existing freeze; select a new output");
  const config = isolatedConfig(configPath);
  const source = sourceRecord();
  const dist = directoryRecord("dist");
  const frozen = { kind: "spec78-t20-build-freeze", at: new Date().toISOString(), ...source, config, dist, knownFolder: knownFolderState() };
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(frozen, null, 2));
  return frozen;
}
export function checkFreeze(frozen, allowHarnessRevision = false) {
  if (frozen.kind !== "spec78-t20-build-freeze") throw Error("Not a T20 build freeze");
  const current = sourceRecord();
  const changedSource=current.source!==frozen.source||current.tree!==frozen.tree;
  const changes=changedSource?git(["diff","--name-only",frozen.source,current.source]).split("\n").filter(Boolean):[];
  if(changedSource&&!allowHarnessRevision)throw Error("The source differs from the frozen build; record an explicit harness-only observation plan or rebuild");
  const allowed=path=>path.startsWith("e2e/")||path==="docs/implementation/spec-78-t20.md"||path.startsWith("docs/implementation/evidence/spec78-t20/");
  if(changedSource&&changes.some(path=>!allowed(path)))throw Error("A product/source change requires a new build: "+changes.filter(path=>!allowed(path)).join(", "));
  const withoutHarness=files=>Object.fromEntries(Object.entries(files).filter(([path])=>!path.startsWith("e2e/")));
  sameFiles(changedSource?withoutHarness(frozen.files):frozen.files,changedSource?withoutHarness(current.files):current.files,"Tracked build inputs");
  sameFiles(frozen.dist.files, directoryRecord(frozen.dist.path).files, "Embedded frontend");
  if (isolatedConfig(frozen.config.path).sha256 !== frozen.config.sha256) throw Error("The exact isolated build config changed");
  return {...current, harnessOnlyChanges:changes};
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
  for (const library of [fixture.a, fixture.b]) {
    if (fileRecord(join(library.info.root, "library.sqlite")).sha256 !== library.databaseInputSha256) throw Error("Fixture database was used or changed before the native round");
    if (fileRecord(library.original).sha256 !== fixture.inputs.old.sha256) throw Error("Legacy original changed");
  }
  return fixture;
}
export function makeNativePlan({ freezePath, application, edgeDriver, tauriDriver, fixturePath, output, allowHarnessRevision = false }) {
  const frozen = readJson(freezePath), observation=checkFreeze(frozen,allowHarnessRevision);
  const file = resolve(output); ownedWork(dirname(file));
  if (existsSync(file)) throw Error("Native plan already exists; retain it and choose a new round");
  knownUnchanged(frozen.knownFolder, knownFolderState());
  const fixtureFile = fileRecord(fixturePath); checkFixture(fixturePath);
  const exe = fileRecord(application);
  if (!exe.path.toLowerCase().startsWith((resolve("target") + sep).toLowerCase())) throw Error("The executable must use this checkout's independent target");
  const plan = { kind: "spec78-t20-native-plan", at: new Date().toISOString(), freeze: fileRecord(freezePath), build: frozen, observation, allowHarnessRevision, application: exe, edgeDriver: fileRecord(edgeDriver), tauriDriver: fileRecord(tauriDriver), fixture: fixtureFile, port: PORT, knownFolder: knownFolderState(), scope: "two-provider-continuous-workflow", nativeExecuted: false, desktopGrant: null };
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(plan, null, 2));
  return plan;
}
export function checkNativePlan(plan) {
  if (plan.kind !== "spec78-t20-native-plan" || plan.port !== PORT || plan.nativeExecuted !== false) throw Error("Not an unused initial T20 native plan");
  if (fileRecord(plan.freeze.path).sha256 !== plan.freeze.sha256) throw Error("Frozen build record changed");
  const observation=checkFreeze(plan.build,plan.allowHarnessRevision===true);
  if(observation.source!==plan.observation.source||observation.tree!==plan.observation.tree)throw Error("The clean observation source changed after its explicit plan");
  sameFiles(plan.observation.files,observation.files,"Actual observation and harness inputs");
  if(JSON.stringify(observation.harnessOnlyChanges)!==JSON.stringify(plan.observation.harnessOnlyChanges))throw Error("The recorded harness-only change list changed");
  for (const key of ["application", "edgeDriver", "tauriDriver", "fixture"]) if (fileRecord(plan[key].path).sha256 !== plan[key].sha256) throw Error(`Native plan ${key} changed`);
  knownUnchanged(plan.knownFolder, knownFolderState());
  return checkFixture(plan.fixture.path);
}
// These functions are only called inside a granted native lifecycle. They preserve this identifier alone.
export function preserveKnownFolder(work, stem = "settings-before") {
  ownedWork(work);
  const before = knownFolderState();
  const saved = python("import pathlib,json,sys,shutil\ns=json.loads(sys.argv[1]); root=pathlib.Path(sys.argv[2]); result=[]\nfor key in ['requested','resolved']:\n item=s[key]; p=pathlib.Path(item['path']); target=root/(sys.argv[3]+'-'+key+'.json')\n if p.is_file(): shutil.copyfile(p,target)\n result.append({'view':key,'original':str(p),'backup':str(target) if p.is_file() else None,**item})\nprint(json.dumps(result))", [JSON.stringify(before), resolve(work), stem]);
  const snapshot = { ...before, saved };
  writeFileSync(join(work, stem + "-metadata.json"), JSON.stringify(snapshot, null, 2));
  return snapshot;
}
export function restoreKnownFolder(snapshot, work) {
  ownedWork(work);
  if (snapshot.identifier !== IDENTIFIER) throw Error("Only the T20 test settings may be restored");
  for (const view of snapshot.saved) if (!view.original.toLowerCase().endsWith((sep + IDENTIFIER + sep + "settings.json").toLowerCase())) throw Error("Unexpected settings path");
  for(const view of snapshot.saved)if(view.backup){const backup=fileRecord(view.backup);if(backup.sha256!==view.sha256||backup.bytes!==view.bytes)throw Error("Preserved before settings bytes changed");}
  const current = knownFolderState();
  if(current.requested.path.toLowerCase()!==snapshot.requested.path.toLowerCase())throw Error("KnownFolder requested identity changed during this round");
  for(const view of [current.requested,current.resolved])if(!view.path.toLowerCase().endsWith((sep+IDENTIFIER+sep+"settings.json").toLowerCase()))throw Error("Unexpected current test settings alias");
  python("import pathlib,json,sys,shutil\ns=json.loads(sys.argv[1]); current=json.loads(sys.argv[3]); root=pathlib.Path(sys.argv[2])\nfor key in ['requested','resolved']:\n p=pathlib.Path(current[key]['path'])\n if p.is_file(): shutil.copyfile(p,root/('settings-after-'+key+'.json'))\n# Existing alias bytes must agree before any restoration mutation.\nif s['requested']['exists']!=s['resolved']['exists'] or s['requested']['sha256']!=s['resolved']['sha256']: raise RuntimeError('Ambiguous before settings alias; preserve current files for root inspection')\nif current['requested']['exists']!=current['resolved']['exists'] or current['requested']['sha256']!=current['resolved']['sha256']: raise RuntimeError('Ambiguous current settings alias; preserve current files for root inspection')\nfor item in s['saved']:\n p=pathlib.Path(item['original'])\n if item['backup']:\n  p.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(item['backup'],p)\n elif p.is_file(): p.unlink()\nprint(json.dumps({'restored':True}))",[JSON.stringify(snapshot),resolve(work),JSON.stringify(current)]);
  const after=knownFolderState(),initiallyAbsent=!snapshot.requested.exists&&!snapshot.resolved.exists;
  // Windows package redirection may become resolvable only after the test directory is created.
  // Freeze/plan checks stay strict. Restoration of an initially absent file permits that mapping
  // change only after both actual views are again absent; no parent directory is removed.
  if(initiallyAbsent) {
    if(after.requested.path.toLowerCase()!==snapshot.requested.path.toLowerCase()||after.requested.exists||after.resolved.exists)throw Error("Previously absent test settings were not removed from both actual aliases");
    if(!after.resolved.path.toLowerCase().endsWith((sep+IDENTIFIER+sep+"settings.json").toLowerCase()))throw Error("Unexpected restored test settings alias");
  } else knownUnchanged(snapshot,after);
  const report={before:snapshot,during:current,after,restored:true,initiallyAbsent,resolutionChanged:snapshot.resolved.path.toLowerCase()!==after.resolved.path.toLowerCase()};
  writeFileSync(join(work, "settings-restoration.json"), JSON.stringify(report, null, 2));
  return report;
}

export function clearKnownFolderForBlank(work) {
  const before=preserveKnownFolder(work,"configured-settings-before-blank");
  python("import pathlib,json,sys\ns=json.loads(sys.argv[1]); removed=[]\nfor item in s['saved']:\n p=pathlib.Path(item['original'])\n if p.is_file(): p.unlink(); removed.append(str(p))\nprint(json.dumps({'removed':removed}))",[JSON.stringify(before)]);
  const after=knownFolderState();
  if(after.requested.exists||after.resolved.exists)throw Error("Blank test settings still exist at a KnownFolder alias");
  const receipt={before,after,scope:"exact T20 test settings only; original pre-run snapshot remains protected"};
  writeFileSync(join(work,"blank-known-folder-boundary.json"),JSON.stringify(receipt,null,2));return receipt;
}
