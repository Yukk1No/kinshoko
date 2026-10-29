// Build provenance for the T20 combined native workflow, moved verbatim from spec78-combination-preflight.mjs (commit size limit).
// spec78-combination-preflight.mjs re-exports everything exported here.
import { spawnSync } from "node:child_process";
import { constants, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { text, readJson, ownedWork, fileRecord, sourceRecord, directoryRecord, sameFiles, isolatedConfig, knownFolderState, knownUnchanged, verifyRecord, sameSnapshot } from "./spec78-combination-preflight.mjs";

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
    native:{executable:process.execPath,args:[resolve("node_modules/@tauri-apps/cli/tauri.js"),"build",...(profile==="debug"?["--debug"]:[]),"--no-bundle",
      // Explicit embedded-frontend feature. (Adding it did not change the 9439a4b EXE bytes; r1's
      // file:// listing came from the absolute frontendDist being parsed as a URL.)
      "--features","tauri/custom-protocol","--target",host,"--config",config.path]},
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
  if(!before.source.files[".cargo/config.toml"]||!before.source.files["crates/kinshoko-core/data/builtin-approx-table.json"]||!before.source.files["crates/kinshoko-core/data/builtin-translation-table.json"])throw Error("Actual crates/kinshoko-core/data and .cargo compilation inputs are missing");
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
