// Offline build provenance and read-only preflight for the T20 combined native workflow.
// No process that owns a window starts when this module is imported or a plan is frozen.
import { spawnSync } from "node:child_process";
import { constants, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  if (resolve(config.build?.frontendDist ?? "") !== resolve("dist")) throw Error("The isolated config must embed this checkout's exact dist");
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
export function knownUnchanged(before, after) {
  for (const key of ["requested", "resolved"]) {
    if (before[key].path.toLowerCase() !== after[key].path.toLowerCase() || before[key].exists !== after[key].exists || before[key].sha256 !== after[key].sha256 || before[key].bytes !== after[key].bytes) throw Error(`KnownFolder ${key} changed after preflight`);
  }
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
export function absentBuildOverrides(environment=process.env) {
  const state=Object.fromEntries(["CARGO_BUILD_TARGET","TAURI_CONFIG"].map(key=>[key,{present:Object.hasOwn(environment,key),value:Object.hasOwn(environment,key)?environment[key]:null}]));
  if(Object.values(state).some(item=>item.present))throw Error("CARGO_BUILD_TARGET and TAURI_CONFIG must both be absent, including empty values: "+JSON.stringify(state));
  return state;
}
export function rustHost(version) {
  const matches=[...version.matchAll(/^host: ([a-zA-Z0-9_.-]+)\r?$/gm)];
  if(matches.length!==1||!matches[0][1].endsWith("-pc-windows-msvc"))throw Error("The actual Rust version must identify one Windows MSVC host");
  return matches[0][1];
}
function buildRecipe(configPath,profile,rust) {
  if(!["debug","release"].includes(profile))throw Error("Choose an explicit debug or release build profile");
  const config=isolatedConfig(configPath),target=resolve("target"),host=rustHost(text(rust.probes[0].stdout.path));
  if(host!==rust.target||rustHost(text(rust.probes[1].stdout.path))!==host)throw Error("Recorded Rust and Cargo hosts must match the explicitly selected native target");
  return {
    cwd:resolve("."),profile,target,artifactDirectory:join(target,host,profile),rust,node:fileRecord(process.execPath),nodeVersion:process.version,
    environment:{CARGO_BUILD_JOBS:"2",CARGO_TARGET_DIR:target,KINSHOKO_SKIP_AUTOSTART:"1",RUSTC:rust.compiler.path,CARGO_BUILD_RUSTC:rust.compiler.path},
    absentOverrides:absentBuildOverrides(),
    frontend:{executable:process.execPath,args:[resolve("node_modules/vite/bin/vite.js"),"build"]},
    native:{executable:process.execPath,args:[resolve("node_modules/@tauri-apps/cli/tauri.js"),"build",...(profile==="debug"?["--debug"]:[]),"--no-bundle","--target",host,"--config",config.path]},
    tools:{vite:fileRecord("node_modules/vite/bin/vite.js"),tauri:fileRecord("node_modules/@tauri-apps/cli/tauri.js")},
    inheritedBuildEnvironment:Object.fromEntries(["PATH","RUSTUP_TOOLCHAIN","RUSTFLAGS","CARGO_ENCODED_RUSTFLAGS","RUSTC","CARGO_BUILD_RUSTC","RUSTC_WRAPPER","RUSTC_WORKSPACE_WRAPPER","CARGO_BUILD_RUSTC_WRAPPER","TS_RS_EXPORT_DIR"].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),
  };
}
export function actualRustToolchain(work,recordProbe) {
  const probeRecipe={cwd:resolve("."),environment:{CARGO_BUILD_JOBS:"2",CARGO_TARGET_DIR:resolve("target"),KINSHOKO_SKIP_AUTOSTART:"1"}};
  const probes=[];
  for(const [label,executable,args] of [["rustc-version","rustc",["-vV"]],["cargo-version","cargo",["-vV"]],["rustc-sysroot","rustc",["--print","sysroot"]]]) {
    const probe=runBuildCommand(label,{executable,args},probeRecipe,work);probes.push(probe);recordProbe(probe);
    if(probe.exit!==0||probe.error)throw Error("The actual Rust toolchain probe failed: "+label);
  }
  const target=rustHost(text(probes[0].stdout.path)),sysroot=resolve(text(probes[2].stdout.path).trim());
  if(rustHost(text(probes[1].stdout.path))!==target)throw Error("Actual Cargo and Rust hosts differ");
  const compiler=fileRecord(join(sysroot,"bin","rustc.exe"));
  const compilerProbe=runBuildCommand("selected-compiler-version",{executable:compiler.path,args:["-vV"]},probeRecipe,work);probes.push(compilerProbe);recordProbe(compilerProbe);
  if(compilerProbe.exit!==0||compilerProbe.error||text(compilerProbe.stdout.path)!==text(probes[0].stdout.path))throw Error("The selected explicit compiler differs from the probed active toolchain");
  return {target,sysroot,compiler,probes};
}
export function runBuildCommand(label,command,recipe,work) {
  const stdoutPath=join(work,label+"-stdout.txt"),stderrPath=join(work,label+"-stderr.txt");
  const stdout=openSync(stdoutPath,"wx"),stderr=openSync(stderrPath,"wx"),startedAt=new Date().toISOString();
  let result;
  try {result=spawnSync(command.executable,command.args,{cwd:recipe.cwd,env:{...process.env,...recipe.environment},windowsHide:true,stdio:["ignore",stdout,stderr]});}
  finally {closeSync(stdout);closeSync(stderr);}
  return {...command,cwd:recipe.cwd,environment:recipe.environment,startedAt,finishedAt:new Date().toISOString(),exit:result.status,signal:result.signal,error:result.error?String(result.error):null,stdout:fileRecord(stdoutPath),stderr:fileRecord(stderrPath)};
}
// This is an explicit build action, never called by import, freeze, plan or native run.
// Each invocation owns a new directory. Existing receipts and frozen binaries are not overwritten.
export function recordAttributedBuild({configPath,work,profile}) {
  const root=ownedWork(work);
  if(existsSync(root))throw Error("Preserve the existing build round; choose a new owned directory");
  const absentOverrides=absentBuildOverrides();
  if(!["debug","release"].includes(profile))throw Error("Choose an explicit debug or release build profile");
  const before={source:sourceRecord(),config:isolatedConfig(configPath),knownFolder:knownFolderState(),retainedT19:knownFolderState("dev.kinshoko.spec78t19upgrade")};
  mkdirSync(root,{recursive:true});
  const path=join(root,"build-receipt.json"),receipt={kind:"spec78-t20-attributed-build",status:"running",startedAt:new Date().toISOString(),absentOverrides,recipe:null,before,rustProbeSteps:[],steps:[],nativeExecuted:false,installerExecuted:false};
  const save=()=>writeFileSync(path,JSON.stringify(receipt,null,2));save();
  try {
    const rust=actualRustToolchain(root,probe=>{receipt.rustProbeSteps.push(probe);save();}),recipe=buildRecipe(configPath,profile,rust);receipt.recipe=recipe;save();
    const frontend=runBuildCommand("frontend",recipe.frontend,recipe,root);receipt.steps.push(frontend);save();
    if(frontend.exit!==0||frontend.error)throw Error("The actual frontend build failed; preserve its raw logs");
    receipt.afterFrontend={source:sourceRecord(),config:isolatedConfig(configPath),dist:directoryRecord("dist")};
    sameSnapshot(before.source,receipt.afterFrontend.source,"Frontend build inputs");
    verifyRecord(before.config,"Isolated config after frontend build");
    receipt.beforeNative={source:sourceRecord(),config:isolatedConfig(configPath),dist:directoryRecord("dist")};save();
    sameSnapshot(receipt.afterFrontend.source,receipt.beforeNative.source,"Inputs before native build");
    sameFiles(receipt.afterFrontend.dist.files,receipt.beforeNative.dist.files,"Dist before native build");
    const native=runBuildCommand("native",recipe.native,recipe,root);receipt.steps.push(native);save();
    if(native.exit!==0||native.error)throw Error("The actual isolated native build failed; preserve its raw logs");
    receipt.afterNative={source:sourceRecord(),config:isolatedConfig(configPath),dist:directoryRecord("dist"),knownFolder:knownFolderState(),retainedT19:knownFolderState("dev.kinshoko.spec78t19upgrade")};
    sameSnapshot(before.source,receipt.afterNative.source,"Native build inputs");
    verifyRecord(before.config,"Isolated config after native build");
    sameFiles(receipt.beforeNative.dist.files,receipt.afterNative.dist.files,"Embedded dist during native build");
    knownUnchanged(before.knownFolder,receipt.afterNative.knownFolder);
    knownUnchanged(before.retainedT19,receipt.afterNative.retainedT19);
    const sourceDirectory=recipe.artifactDirectory,frozenDirectory=join(root,"frozen-runtime");
    const names=readdirSync(sourceDirectory).filter(name=>/\.dll$/i.test(name)).sort();
    if(!names.some(name=>name.toLowerCase()==="directml.dll"))throw Error("The actual native build must supply DirectML.dll beside kinshoko.exe");
    mkdirSync(frozenDirectory);
    const freezeFile=name=>{
      const source=fileRecord(join(sourceDirectory,name)),destination=join(frozenDirectory,name);
      copyFileSync(source.path,destination,constants.COPYFILE_EXCL);
      const frozen=fileRecord(destination);
      if(source.bytes!==frozen.bytes||source.sha256!==frozen.sha256)throw Error("Frozen binary/runtime copy differs: "+name);
      verifyRecord(source,"Native artifact during freezing");
      return {source,frozen};
    };
    receipt.artifacts={directory:frozenDirectory,application:freezeFile("kinshoko.exe"),runtime:Object.fromEntries(names.map(name=>[name,freezeFile(name)]))};
    receipt.status="built-frozen";receipt.finishedAt=new Date().toISOString();save();
    return {status:receipt.status,receipt:fileRecord(path),application:receipt.artifacts.application.frozen,runtime:Object.fromEntries(Object.entries(receipt.artifacts.runtime).map(([name,item])=>[name,item.frozen])),nativeExecuted:false,installerExecuted:false};
  } catch(error) {
    receipt.status="failed";receipt.error=String(error);receipt.finishedAt=new Date().toISOString();
    try{receipt.failureSource=sourceRecord();}catch(observation){receipt.failureSource={unconfirmed:true,error:String(observation)};}
    save();throw error;
  }
}
export function checkAttributedBuild(receiptPath) {
  const record=fileRecord(receiptPath);ownedWork(dirname(record.path));const receipt=readJson(record.path);
  if(receipt.kind!=="spec78-t20-attributed-build"||receipt.status!=="built-frozen")throw Error("A successful actual attributed build receipt is required; separate current EXE/config hashes are insufficient");
  const {recipe,before,afterFrontend,beforeNative,afterNative,steps,artifacts}=receipt;
  if(receipt.nativeExecuted!==false||receipt.installerExecuted!==false||recipe.cwd!==resolve(".")||recipe.target!==resolve("target"))throw Error("The build receipt belongs to another checkout or lifecycle");
  if(JSON.stringify(receipt.absentOverrides)!==JSON.stringify(absentBuildOverrides())||JSON.stringify(recipe.absentOverrides)!==JSON.stringify(receipt.absentOverrides))throw Error("Actual build override absence is missing or changed");
  if(!recipe.rust?.compiler||recipe.rust.probes?.length!==4||JSON.stringify(receipt.rustProbeSteps)!==JSON.stringify(recipe.rust.probes))throw Error("Actual Rust target, compiler and four version/sysroot command observations are required");
  verifyRecord(recipe.rust.compiler,"Recorded explicit Rust compiler");
  const expectedProbes=[["rustc",["-vV"]],["cargo",["-vV"]],["rustc",["--print","sysroot"]],[recipe.rust.compiler.path,["-vV"]]];
  for(const [index,probe] of recipe.rust.probes.entries()) {
    const [executable,args]=expectedProbes[index];
    if(probe.exit!==0||probe.error||probe.cwd!==recipe.cwd||probe.executable!==executable||JSON.stringify(probe.args)!==JSON.stringify(args))throw Error("Actual Rust toolchain command/exit is missing or differs");
    verifyRecord(probe.stdout,"Rust probe stdout");verifyRecord(probe.stderr,"Rust probe stderr");
  }
  if(resolve(text(recipe.rust.probes[2].stdout.path).trim())!==recipe.rust.sysroot||recipe.rust.compiler.path!==join(recipe.rust.sysroot,"bin","rustc.exe")||text(recipe.rust.probes[3].stdout.path)!==text(recipe.rust.probes[0].stdout.path))throw Error("Rust sysroot/compiler attribution differs");
  const expected=buildRecipe(before.config.path,recipe.profile,recipe.rust);
  for(const key of ["frontend","native","environment","artifactDirectory"])if(JSON.stringify(recipe[key])!==JSON.stringify(expected[key]))throw Error("The exact isolated build recipe differs: "+key);
  verifyRecord(recipe.node,"Recorded Node runtime");
  for(const [name,tool] of Object.entries(recipe.tools))verifyRecord(tool,"Recorded build tool "+name);
  if(steps.length!==2)throw Error("Both actual frontend and native build commands are required");
  for(const [index,key] of ["frontend","native"].entries()) {
    const step=steps[index],command=recipe[key];
    if(step.exit!==0||step.error||step.executable!==command.executable||JSON.stringify(step.args)!==JSON.stringify(command.args)||step.cwd!==recipe.cwd||JSON.stringify(step.environment)!==JSON.stringify(recipe.environment))throw Error("The actual "+key+" command/exit does not match its recipe");
    verifyRecord(step.stdout,key+" stdout");verifyRecord(step.stderr,key+" stderr");
  }
  for(const [label,snapshot] of [["after frontend",afterFrontend],["before native",beforeNative],["after native",afterNative]]) {
    sameSnapshot(before.source,snapshot.source,"Build inputs "+label);
    if(snapshot.config.path!==before.config.path||snapshot.config.sha256!==before.config.sha256||snapshot.config.bytes!==before.config.bytes)throw Error("Config changed "+label);
  }
  if(!before.source.files[".cargo/config.toml"]||!before.source.files["data/builtin-approx-table.json"]||!before.source.files["data/builtin-translation-table.json"])throw Error("Actual data/.cargo compilation inputs are missing");
  sameFiles(afterFrontend.dist.files,beforeNative.dist.files,"Frontend output before native");
  sameFiles(beforeNative.dist.files,afterNative.dist.files,"Embedded frontend during native");
  verifyRecord(before.config,"Attributed isolated config");
  knownUnchanged(before.knownFolder,afterNative.knownFolder);knownUnchanged(before.retainedT19,afterNative.retainedT19);
  ownedWork(artifacts.directory);
  if(dirname(artifacts.application.frozen.path)!==artifacts.directory||artifacts.application.source.path!==join(recipe.artifactDirectory,"kinshoko.exe"))throw Error("Application provenance is not the actual isolated target output and owned frozen copy");
  const entries=[["kinshoko.exe",artifacts.application],...Object.entries(artifacts.runtime)];
  if(!entries.some(([name])=>name.toLowerCase()==="directml.dll"))throw Error("Frozen DirectML runtime is required");
  for(const [name,item] of entries) {
    if(dirname(item.frozen.path)!==artifacts.directory||item.frozen.path!==join(artifacts.directory,name)||item.source.path!==join(recipe.artifactDirectory,name))throw Error("A frozen runtime path escaped its exact build directory");
    verifyRecord(item.frozen,"Frozen native "+name);
    if(item.source.sha256!==item.frozen.sha256||item.source.bytes!==item.frozen.bytes)throw Error("The frozen native file differs from its actual build output: "+name);
  }
  if(JSON.stringify(readdirSync(artifacts.directory).sort())!==JSON.stringify(entries.map(([name])=>name).sort()))throw Error("The frozen executable directory has missing or unrecorded adjacent runtime files");
  return {record,receipt,application:artifacts.application.frozen,runtime:Object.fromEntries(Object.entries(artifacts.runtime).map(([name,item])=>[name,item.frozen]))};
}
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
  knownUnchanged(frozen.knownFolder,knownFolderState());
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
