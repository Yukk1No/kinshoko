// T20 release NSIS preparation and attributed build. Import-safe.
// Build is an explicit action. No installed product, registry or app is touched here.
import {constants,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from "node:fs";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {sha256} from "./spec78-combination-fixture.mjs";
import {requireFinalOriginalSource} from "./spec78-combination-original.mjs";
import {absentBuildOverrides,actualRustToolchain,directoryRecord,fileRecord,knownFolderState,knownUnchanged,ownedWork,readJson,runBuildCommand,rustHost,sameFiles,sameSnapshot,sourceRecord,verifyRecord} from "./spec78-combination-preflight.mjs";

export const INSTALLER_IDENTITY={identifier:"dev.kinshoko.spec78t19upgrade",productName:"Kinshoko T19 Upgrade Probe",mainBinaryName:"kinshoko-t19-upgrade"};
export const OLD_INSTALLER_SHA="b1ee1339bbc0e9e2981d50f6519409aab81b73f3574504a857a6fd0afb2a8e91";
const oldConfigSha="f02d0c07d052ddc0e47e84aa4d6f34435fb6bc65aba87543596004f22f470cc3",oldEvidenceSha="3756810ff4ac8526d2661138b86b78cb5717ee7170251044589b10ac2f9d6a78";
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Error(message);};
const harnessPath=fileURLToPath(import.meta.url),repository=resolve(dirname(harnessPath),"..");
function ownedAt(path,repo) {
  if(!isAbsolute(path)||realpathSync(repo)!==realpathSync(repository))fail("The callback must bind this actual harness repository explicitly");
  const root=resolve(path),base=join(repo,"work","e2e"),name=relative(base,root);
  if(!name||isAbsolute(name)||name===".."||name.startsWith(".."+sep)||!name.includes("spec78-t20"))fail("The callback output must belong to this repository's owned T20 work");
  // Existing parents are resolved as well; a junction cannot redirect the frozen output.
  const canonical=realpathSync(existsSync(root)?root:dirname(root)),canonicalBase=realpathSync(base),canonicalName=relative(canonicalBase,canonical);
  if(isAbsolute(canonicalName)||canonicalName===".."||canonicalName.startsWith(".."+sep))fail("The callback output resolves outside the owned repository work");
  return root;
}
function writeNew(path,value){if(existsSync(path))fail("Preserve the existing installer preparation: "+path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value,null,2),{flag:"wx"});}
export function oldInstallerInputs({installerPath,configPath,evidencePath}) {
  const installer=fileRecord(installerPath),config=fileRecord(configPath),evidence=fileRecord(evidencePath),old=readJson(evidence.path),settings=readJson(config.path);
  if(installer.sha256!==OLD_INSTALLER_SHA||installer.bytes!==38220605||config.sha256!==oldConfigSha||evidence.sha256!==oldEvidenceSha)fail("Use the exact preserved actual 0.1.0 T19 baseline inputs");
  for(const [key,value] of Object.entries(INSTALLER_IDENTITY))if(settings[key]!==value||old[key]!==value)fail("Preserve the old isolated installation identity: "+key);
  if(settings.version!=="0.1.0"||old.old.bundleVersion!=="0.1.0"||old.buildProfile!=="debug"||old.old.sourceRevision!=="536cc43c1933e44fc33836f8a439de8cdb0da018"||old.old.installerSha256!==installer.sha256||old.old.configSha256!==config.sha256)fail("The old actual debug baseline must remain accurately attributed");
  return {installer,config,evidence,source:old.old.sourceRevision,profile:"debug",bundleVersion:"0.1.0",workspaceVersion:old.old.workspaceVersion,bareExeSha256:old.old.exeSha256,packagedExeSha256:old.old.packagedExeSha256,directmlSha256:old.old.directmlSha256};
}
export function validateInstallerConfig(config,version,work,repo=resolve(".")) {
  if(!/^0\.1\.(?:[2-9]|[1-9][0-9]+)$/.test(version))fail("Use an explicit isolated bundle version after the actual 0.1.0/0.1.1 baselines");
  for(const [key,value] of Object.entries(INSTALLER_IDENTITY))if(config[key]!==value)fail("The NSIS config must retain the exact isolated T19 identity");
  if(config.version!==version||config.build?.devUrl!==null||config.build?.beforeBuildCommand!==null||config.build?.beforeDevCommand!==null||typeof config.build.frontendDist!=="string"||/^[a-z][a-z0-9+.-]*:/i.test(config.build.frontendDist)||resolve(repo,"src-tauri",config.build.frontendDist)!==join(repo,"dist"))fail("Use the exact embedded final frontend with explicit recorded build commands");
  if(config.bundle?.active!==true||!eq(config.bundle.targets,["nsis"])||config.bundle.createUpdaterArtifacts!==false||config.bundle.windows?.nsis?.installMode!=="currentUser"||config.bundle.windows.nsis.installerHooks!==join(work,"release-installer-hooks.nsh"))fail("This plan must produce isolated current-user release NSIS only");
  if(config.plugins?.updater?.pubkey||config.plugins?.updater?.releaseStage!=="private")fail("Do not enable public signed updates as part of this local installer test");
  return config;
}
export function prepareInstallerBuild({work,installerPath,configPath,evidencePath,version="0.1.2"}) {
  const root=ownedWork(work);if(existsSync(root))fail("Use a new owned release installer preparation");
  const old=oldInstallerInputs({installerPath,configPath,evidencePath}),source=sourceRecord(),base=readJson("src-tauri/tauri.conf.json");
  absentBuildOverrides();
  const config={...base,...INSTALLER_IDENTITY,version,build:{...base.build,devUrl:null,beforeBuildCommand:null,beforeDevCommand:null,frontendDist:"../dist"},bundle:{...base.bundle,active:true,targets:["nsis"],createUpdaterArtifacts:false,windows:{...base.bundle.windows,nsis:{...base.bundle.windows.nsis,installMode:"currentUser",installerHooks:join(root,"release-installer-hooks.nsh")}}}};
  validateInstallerConfig(config,version,root);
  mkdirSync(root,{recursive:true});writeNew(join(root,"release.conf.json"),config);
  const plan={kind:"spec78-t20-release-installer-build-plan",status:"prepared-not-built",at:new Date().toISOString(),repository,source,old,version,identity:INSTALLER_IDENTITY,profile:"release",config:fileRecord(join(root,"release.conf.json")),productionHook:fileRecord("src-tauri/installer-hooks.nsh"),harness:fileRecord("e2e/spec78-combination-installer.mjs"),work:root,actualRustTarget:"pending explicit build probe",runtimeHook:"generated from actual release runtime after native build, before bundle",installerExecuted:false,nativeExecuted:false,fullT20Acceptance:false};
  writeNew(join(root,"installer-build-plan.json"),plan);return plan;
}
// Exact pinned CLI marker operation. This derived result is NOT called an extracted
// packaged artifact. The bundle-time helper below must observe that actual artifact.
export function expectedNsisPackagedBytes(bare) {
  const token=Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK"),replacement=Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS"),offset=bare.indexOf(token);
  if(offset<0)fail("The actual bare EXE lacks the pinned Tauri unknown bundle marker");
  const packaged=Buffer.from(bare);replacement.copy(packaged,offset);
  const changed=[];for(let index=0;index<bare.length;index++)if(bare[index]!==packaged[index])changed.push(index);
  if(changed.length!==3)fail("The pinned NSIS contract must change exactly three marker bytes");
  return {bytes:packaged,offset,changed,sha256:sha256(packaged)};
}
export function validateNsisCallbackBinding(bindingPath,sourcePath,barePath,output) {
  const record=fileRecord(bindingPath),binding=readJson(record.path);
  if(binding.kind!=="spec78-t20-release-nsis-callback-binding"||binding.repository!==repository)fail("An explicit actual repository/plan/harness callback binding is required");
  verifyRecord(binding.plan,"Callback release plan");const plan=readJson(binding.plan.path),repo=binding.repository,work=ownedAt(plan.work,repo),build=join(work,"actual-release-build"),frozen=join(build,"frozen-artifacts");
  if(record.path!==join(build,"nsis-callback-binding.json")||binding.plan.path!==join(work,"installer-build-plan.json")||plan.kind!=="spec78-t20-release-installer-build-plan"||plan.status!=="prepared-not-built"||plan.repository!==repo||plan.profile!=="release"||!eq(plan.identity,INSTALLER_IDENTITY)||!eq(plan.source,binding.source))fail("The callback differs from its actual immutable release plan");
  for(const key of ["harness","config"])if(!eq(plan[key],binding[key]))fail("The callback has a different plan "+key);
  if(binding.harness.path!==harnessPath||!eq(fileRecord(harnessPath),binding.harness)||binding.config.path!==join(work,"release.conf.json"))fail("The callback must use the exact bound harness and isolated config");
  verifyRecord(binding.config,"Callback isolated config");validateInstallerConfig(readJson(binding.config.path),plan.version,work,repo);
  for(const [name,expected] of Object.entries(binding.source.files))verifyRecord({...expected,path:join(repo,name)},"Callback actual source input");
  const path=ownedAt(resolve(output),repo);
  if(sourcePath!==binding.actualPath||sourcePath!==join(binding.artifactDirectory,INSTALLER_IDENTITY.mainBinaryName+".exe")||barePath!==binding.bare.path||barePath!==join(frozen,"bare-"+INSTALLER_IDENTITY.mainBinaryName+".exe")||path!==binding.output||path!==join(frozen,"nsis-packaged-"+INSTALLER_IDENTITY.mainBinaryName+".exe"))fail("The callback arguments differ from their exact release artifact binding");
  if(binding.hook.path!==join(work,"release-installer-hooks.nsh")||binding.runtimeInclude.path!==join(work,"actual-release-runtime.nsh"))fail("The callback hook paths differ from the release plan");
  verifyRecord(binding.bare,"Callback frozen bare EXE");verifyRecord(binding.hook,"Callback actual hook");verifyRecord(binding.runtimeInclude,"Callback actual runtime include");
  if(!Object.keys(binding.runtime).some(name=>name.toLowerCase()==="directml.dll"))fail("The callback lacks the actual release runtime");
  for(const [name,item] of Object.entries(binding.runtime)) {
    if(!/^[A-Za-z0-9_.-]+\.dll$/i.test(name)||item.path!==join(binding.artifactDirectory,name))fail("The callback runtime does not belong to its actual artifact directory");
    verifyRecord(item,"Callback actual runtime "+name);
  }
  return {record,binding,path};
}
export function captureActualPackagedExe(sourcePath,barePath,output,bindingPath) {
  const context=validateNsisCallbackBinding(bindingPath,sourcePath,barePath,output),path=context.path;
  if(existsSync(path)||existsSync(path+".json"))fail("Do not overwrite a prior actual NSIS compile-time observation");
  const bare=fileRecord(barePath),actual=fileRecord(sourcePath),expected=expectedNsisPackagedBytes(readFileSync(bare.path)),bytes=readFileSync(actual.path);
  if(!bytes.equals(expected.bytes))fail("The actual NSIS compile-time EXE differs from the exact pinned three-byte marker operation");
  copyFileSync(actual.path,path,constants.COPYFILE_EXCL);const frozen=fileRecord(path);verifyRecord({...actual,path},"Frozen actual NSIS packaged EXE");
  const receipt={kind:"spec78-t20-actual-nsis-compile-exe",at:new Date().toISOString(),binding:{repository:context.binding.repository,record:context.record,plan:context.binding.plan,harness:context.binding.harness},bare,actual,frozen,marker:{offset:expected.offset,changedBytes:expected.changed},installerExecuted:false};
  writeNew(path+".json",receipt);return receipt;
}
function nsisPath(path) {
  const value=resolve(path);
  if(/["'\r\n$]/.test(value))fail("The explicit NSIS test path contains unsupported command syntax");
  return value;
}
export function renderReleaseHook({runtime,artifactDirectory,bareExe,packagedExe,callbackBinding}) {
  if(!Object.keys(runtime).some(name=>name.toLowerCase()==="directml.dll"))fail("A real release DirectML runtime is required");
  if(!isAbsolute(callbackBinding??""))fail("The NSIS callback needs its explicit immutable release binding path");
  const args=[process.execPath,harnessPath,"--capture-nsis",callbackBinding,join(artifactDirectory,INSTALLER_IDENTITY.mainBinaryName+".exe"),bareExe,packagedExe].map(nsisPathOrOption);
  const lines=["; T20 exact release NSIS hook. No application/registry commands.","!system '"+args.map(value=>'"'+value+'"').join(" ")+"' = 0","!macro NSIS_HOOK_POSTINSTALL",'  SetOutPath "$INSTDIR"'];
  for(const [name,record] of Object.entries(runtime).sort()) {
    if(!/^[A-Za-z0-9_.-]+\.dll$/i.test(name)||record.path!==join(artifactDirectory,name))fail("Unexpected actual release runtime path");
    lines.push('  File "'+nsisPath(record.path)+'"');
  }
  lines.push("!macroend","!macro NSIS_HOOK_PREUNINSTALL");
  for(const name of Object.keys(runtime).sort())lines.push('  Delete "$INSTDIR\\'+name+'"');
  lines.push("!macroend","");
  return lines.join("\n");
}
function nsisPathOrOption(value){return value==="--capture-nsis"?value:nsisPath(value);}
function freezeFile(source,root,name) {
  const original=fileRecord(source),path=join(root,name);
  copyFileSync(original.path,path,constants.COPYFILE_EXCL);
  const frozen=verifyRecord({...original,path},"Owned frozen installer build artifact");
  verifyRecord(original,"Actual artifact after freezing");
  return {source:original,frozen};
}
// Only this explicit action runs the compiler and bundle commands. It never runs an
// installer/app, examines Run, or mutates installed state. Root must schedule the build.
export function recordReleaseInstallerBuild(planPath) {
  const plan=readJson(planPath),work=ownedWork(plan.work);
  if(plan.kind!=="spec78-t20-release-installer-build-plan"||plan.status!=="prepared-not-built"||plan.profile!=="release"||!eq(plan.identity,INSTALLER_IDENTITY))fail("An exact fresh release installer preparation is required");
  if(plan.repository!==repository||resolve(".")!==repository)fail("The actual release build must run in the bound harness repository");
  verifyRecord(plan.config,"Isolated NSIS config");verifyRecord(plan.productionHook,"Production NSIS hook");verifyRecord(plan.harness,"Installer build harness");
  validateInstallerConfig(readJson(plan.config.path),plan.version,work);
  oldInstallerInputs({installerPath:plan.old.installer.path,configPath:plan.old.config.path,evidencePath:plan.old.evidence.path});
  const source=sourceRecord();sameSnapshot(plan.source,source,"Prepared final installer source");const originalSource=requireFinalOriginalSource(source.source),overrides=absentBuildOverrides();
  const build=join(work,"actual-release-build");if(existsSync(build))fail("Preserve the previous release build round");
  mkdirSync(build);const path=join(build,"installer-build-receipt.json");
  const receipt={kind:"spec78-t20-attributed-release-nsis-build",status:"running",startedAt:new Date().toISOString(),plan:fileRecord(planPath),identity:INSTALLER_IDENTITY,profile:"release",version:plan.version,originalSource,absentOverrides:overrides,recipe:null,steps:[],rustProbeSteps:[],before:{source,config:plan.config,knownT20:knownFolderState(),knownT19:knownFolderState(INSTALLER_IDENTITY.identifier)},nativeExecuted:false,installerExecuted:false,fullT20Acceptance:false};
  const save=()=>writeFileSync(path,JSON.stringify(receipt,null,2));save();
  try {
    const rust=actualRustToolchain(build,probe=>{receipt.rustProbeSteps.push(probe);save();}),target=resolve("target");
    const recipe={cwd:resolve("."),target,profile:"release",artifactDirectory:join(target,rust.target,"release"),rust,node:fileRecord(process.execPath),nodeVersion:process.version,environment:{CARGO_BUILD_JOBS:"2",CARGO_TARGET_DIR:target,KINSHOKO_SKIP_AUTOSTART:"1",RUSTC:rust.compiler.path,CARGO_BUILD_RUSTC:rust.compiler.path},inheritedBuildEnvironment:Object.fromEntries(["PATH","RUSTUP_TOOLCHAIN","RUSTFLAGS","CARGO_ENCODED_RUSTFLAGS","RUSTC","CARGO_BUILD_RUSTC","RUSTC_WRAPPER","RUSTC_WORKSPACE_WRAPPER","CARGO_BUILD_RUSTC_WRAPPER","TS_RS_EXPORT_DIR"].filter(key=>Object.hasOwn(process.env,key)).map(key=>[key,process.env[key]])),tools:{vite:fileRecord("node_modules/vite/bin/vite.js"),tauri:fileRecord("node_modules/@tauri-apps/cli/tauri.js")},frontend:{executable:process.execPath,args:[resolve("node_modules/vite/bin/vite.js"),"build"]},native:{executable:process.execPath,args:[resolve("node_modules/@tauri-apps/cli/tauri.js"),"build","--no-bundle","--target",rust.target,"--config",plan.config.path]},bundle:{executable:process.execPath,args:[resolve("node_modules/@tauri-apps/cli/tauri.js"),"bundle","--bundles","nsis","--target",rust.target,"--config",plan.config.path]}};
    receipt.recipe=recipe;save();
    const frontend=runBuildCommand("frontend",recipe.frontend,recipe,build);receipt.steps.push(frontend);save();if(frontend.exit!==0||frontend.error)fail("Actual release frontend build failed");
    // Keep the configured hook file real before the native CLI validates paths.
    // Only the later explicit NSIS bundle executes the runtime include.
    const runtimeInclude=join(work,"actual-release-runtime.nsh");
    writeNew(join(work,"release-installer-hooks.nsh"),"; T20 recorded release hook entry\n!include \""+nsisPath(runtimeInclude)+"\"\n");
    receipt.beforeNative={source:sourceRecord(),config:fileRecord(plan.config.path),dist:directoryRecord("dist"),hook:fileRecord(join(work,"release-installer-hooks.nsh"))};
    sameSnapshot(source,receipt.beforeNative.source,"Frontend source inputs");verifyRecord(plan.config,"NSIS config after frontend");
    const native=runBuildCommand("native-release",recipe.native,recipe,build);receipt.steps.push(native);save();if(native.exit!==0||native.error)fail("Actual release native build failed");
    receipt.afterNative={source:sourceRecord(),config:fileRecord(plan.config.path),dist:directoryRecord("dist")};
    sameSnapshot(source,receipt.afterNative.source,"Actual release source inputs");verifyRecord(plan.config,"NSIS config after native");sameFiles(receipt.beforeNative.dist.files,receipt.afterNative.dist.files,"Release embedded frontend");
    const runtimeNames=readdirSync(recipe.artifactDirectory).filter(name=>/\.dll$/i.test(name)).sort(),runtime=Object.fromEntries(runtimeNames.map(name=>[name,fileRecord(join(recipe.artifactDirectory,name))]));
    if(!runtimeNames.some(name=>name.toLowerCase()==="directml.dll"))fail("Actual release build has no DirectML.dll");
    const frozen=join(build,"frozen-artifacts");mkdirSync(frozen);
    receipt.artifacts={directory:frozen,bare:freezeFile(join(recipe.artifactDirectory,INSTALLER_IDENTITY.mainBinaryName+".exe"),frozen,"bare-"+INSTALLER_IDENTITY.mainBinaryName+".exe"),runtime:Object.fromEntries(runtimeNames.map(name=>[name,freezeFile(runtime[name].path,frozen,name)]))};
    const packagedExe=join(frozen,"nsis-packaged-"+INSTALLER_IDENTITY.mainBinaryName+".exe"),callbackBinding=join(build,"nsis-callback-binding.json"),hook=renderReleaseHook({runtime,artifactDirectory:recipe.artifactDirectory,bareExe:receipt.artifacts.bare.frozen.path,packagedExe,callbackBinding});
    writeNew(runtimeInclude,hook);receipt.actualRuntimeInclude=fileRecord(runtimeInclude);receipt.actualHook=fileRecord(join(work,"release-installer-hooks.nsh"));
    const bundleDirectory=join(recipe.artifactDirectory,"bundle","nsis");
    if(existsSync(bundleDirectory)&&readdirSync(bundleDirectory).some(name=>name.toLowerCase().endsWith(".exe")))fail("Preserve existing NSIS outputs; this explicit build needs an unused package output");
    receipt.beforeBundle={source:sourceRecord(),config:fileRecord(plan.config.path),dist:directoryRecord("dist"),hook:receipt.actualHook,runtimeInclude:receipt.actualRuntimeInclude};
    writeNew(callbackBinding,{kind:"spec78-t20-release-nsis-callback-binding",repository,plan:receipt.plan,harness:plan.harness,config:plan.config,source:receipt.beforeBundle.source,artifactDirectory:recipe.artifactDirectory,bare:receipt.artifacts.bare.frozen,actualPath:receipt.artifacts.bare.source.path,output:packagedExe,runtime,hook:receipt.actualHook,runtimeInclude:receipt.actualRuntimeInclude});receipt.actualCallbackBinding=fileRecord(callbackBinding);save();
    const bundle=runBuildCommand("bundle-nsis-release",recipe.bundle,recipe,build);receipt.steps.push(bundle);save();if(bundle.exit!==0||bundle.error)fail("Actual release NSIS bundle failed");
    const packaged=readJson(packagedExe+".json");verifyRecord(packaged.frozen,"Actual compile-time packaged EXE");verifyRecord(packaged.bare,"Actual bare release EXE");
    if(packaged.bare.sha256!==receipt.artifacts.bare.frozen.sha256)fail("Compile-time packaged EXE belongs to another bare release build");
    receipt.artifacts.packaged=packaged;receipt.artifacts.packagedObservation=fileRecord(packagedExe+".json");
    const names=readdirSync(bundleDirectory).filter(name=>name.toLowerCase().endsWith(".exe"));
    if(names.length!==1)fail("Expected one exact new release NSIS package");
    receipt.artifacts.installer=freezeFile(join(bundleDirectory,names[0]),frozen,"new-"+plan.version+"-release-setup.exe");
    receipt.afterBundle={source:sourceRecord(),config:fileRecord(plan.config.path),dist:directoryRecord("dist"),hook:fileRecord(receipt.actualHook.path),runtimeInclude:fileRecord(receipt.actualRuntimeInclude.path),knownT20:knownFolderState(),knownT19:knownFolderState(INSTALLER_IDENTITY.identifier)};
    sameSnapshot(source,receipt.afterBundle.source,"Final release bundle source");verifyRecord(plan.config,"Final NSIS config");verifyRecord(receipt.actualHook,"Final exact release hook");verifyRecord(receipt.actualRuntimeInclude,"Actual release DLL/packaged-EXE include");
    sameFiles(receipt.beforeNative.dist.files,receipt.afterBundle.dist.files,"Final release embedded dist");
    knownUnchanged(receipt.before.knownT20,receipt.afterBundle.knownT20);knownUnchanged(receipt.before.knownT19,receipt.afterBundle.knownT19);
    // Tauri restores the unknown marker after bundle. Do not call this the installed file.
    verifyRecord(receipt.artifacts.bare.source,"Bare target EXE restored after bundle");
    for(const item of Object.values(receipt.artifacts.runtime))verifyRecord(item.source,"Actual release runtime after bundle");
    receipt.status="built-frozen-release-nsis";receipt.finishedAt=new Date().toISOString();save();
    return {status:receipt.status,receipt:fileRecord(path),installer:receipt.artifacts.installer.frozen,bare:receipt.artifacts.bare.frozen,actualPackaged:receipt.artifacts.packaged.frozen,runtime:receipt.artifacts.runtime,nativeExecuted:false,installerExecuted:false,fullT20Acceptance:false};
  }catch(error){receipt.status="failed";receipt.error=String(error);receipt.finishedAt=new Date().toISOString();try{receipt.failureSource=sourceRecord();}catch(observation){receipt.failureSource={unconfirmed:true,error:String(observation)};}save();throw error;}
}
export function checkReleaseInstallerBuild(receiptPath) {
  const record=fileRecord(receiptPath);ownedWork(dirname(record.path));const receipt=readJson(record.path);
  if(receipt.kind!=="spec78-t20-attributed-release-nsis-build"||receipt.status!=="built-frozen-release-nsis"||receipt.profile!=="release"||receipt.nativeExecuted!==false||receipt.installerExecuted!==false||!eq(receipt.identity,INSTALLER_IDENTITY))fail("A successful actual release NSIS receipt is required");
  verifyRecord(receipt.plan,"Actual release plan");const plan=readJson(receipt.plan.path);
  if(plan.repository!==repository)fail("The release plan does not bind this actual repository");
  validateInstallerConfig(readJson(plan.config.path),receipt.version,plan.work);
  const old=oldInstallerInputs({installerPath:plan.old.installer.path,configPath:plan.old.config.path,evidencePath:plan.old.evidence.path});
  const {recipe,before,beforeNative,afterNative,beforeBundle,afterBundle,steps,rustProbeSteps,artifacts}=receipt;
  if(!recipe||recipe.cwd!==resolve(".")||recipe.target!==resolve("target")||recipe.profile!=="release"||steps.length!==3)fail("Actual frontend, release native and NSIS bundle commands are required");
  if(!eq(receipt.absentOverrides,absentBuildOverrides())||recipe.rust?.probes?.length!==4||!eq(rustProbeSteps,recipe.rust.probes))fail("Actual Rust observations and absent inherited target/config are required");
  const probeCommands=[["rustc",["-vV"]],["cargo",["-vV"]],["rustc",["--print","sysroot"]],[recipe.rust.compiler.path,["-vV"]]];
  for(const [index,probe] of rustProbeSteps.entries()) {
    if(probe.exit!==0||probe.error||probe.cwd!==recipe.cwd||probe.executable!==probeCommands[index][0]||!eq(probe.args,probeCommands[index][1]))fail("Actual Rust probe command/exit differs");
    verifyRecord(probe.stdout,"Actual Rust stdout");verifyRecord(probe.stderr,"Actual Rust stderr");
  }
  const version=readFileSync(rustProbeSteps[0].stdout.path,"utf8"),host=rustHost(version);
  if(rustHost(readFileSync(rustProbeSteps[1].stdout.path,"utf8"))!==host||recipe.rust.target!==host||recipe.rust.sysroot!==resolve(readFileSync(rustProbeSteps[2].stdout.path,"utf8").trim())||recipe.rust.compiler.path!==join(recipe.rust.sysroot,"bin","rustc.exe")||readFileSync(rustProbeSteps[3].stdout.path,"utf8")!==version||recipe.artifactDirectory!==join(recipe.target,host,"release"))fail("Actual Rust host/compiler/artifact attribution differs");
  verifyRecord(recipe.rust.compiler,"Selected actual compiler");verifyRecord(recipe.node,"Build Node runtime");
  const expectedEnvironment={CARGO_BUILD_JOBS:"2",CARGO_TARGET_DIR:recipe.target,KINSHOKO_SKIP_AUTOSTART:"1",RUSTC:recipe.rust.compiler.path,CARGO_BUILD_RUSTC:recipe.rust.compiler.path};
  if(!eq(recipe.environment,expectedEnvironment))fail("The actual release build environment differs");
  const commands=[
    [recipe.node.path,[resolve("node_modules/vite/bin/vite.js"),"build"]],
    [recipe.node.path,[resolve("node_modules/@tauri-apps/cli/tauri.js"),"build","--no-bundle","--target",host,"--config",plan.config.path]],
    [recipe.node.path,[resolve("node_modules/@tauri-apps/cli/tauri.js"),"bundle","--bundles","nsis","--target",host,"--config",plan.config.path]],
  ];
  for(const [index,key] of ["frontend","native","bundle"].entries())if(recipe[key]?.executable!==commands[index][0]||!eq(recipe[key]?.args,commands[index][1]))fail("The recorded release recipe differs from its actual command: "+key);
  if(!eq(Object.keys(recipe.tools).sort(),["tauri","vite"])||recipe.tools.vite.path!==commands[0][1][0]||recipe.tools.tauri.path!==commands[1][1][0])fail("Both exact actual build tool paths are required");
  for(const [index,step] of steps.entries()) {
    if(step.exit!==0||step.error||step.executable!==commands[index][0]||!eq(step.args,commands[index][1])||step.cwd!==recipe.cwd||!eq(step.environment,recipe.environment))fail("The actual release build/bundle command or exit differs");
    verifyRecord(step.stdout,"Actual build stdout");verifyRecord(step.stderr,"Actual build stderr");
  }
  for(const [name,tool] of Object.entries(recipe.tools))verifyRecord(tool,"Actual build tool "+name);
  for(const phase of [beforeNative,afterNative,beforeBundle,afterBundle]) {
    sameSnapshot(before.source,phase.source,"Actual release phase inputs");
    if(!eq(before.config,phase.config))fail("Actual release config changed");
    sameFiles(beforeNative.dist.files,phase.dist.files,"Actual release embedded dist");
  }
  if(!before.source.files[".cargo/config.toml"]||!before.source.files["data/builtin-translation-table.json"]||!before.source.files["data/builtin-approx-table.json"])fail("Actual data/.cargo build inputs are missing");
  if(!eq(plan.config,before.config))fail("The actual release build began with a different isolated config");
  sameSnapshot(plan.source,before.source,"Prepared release source");sameSnapshot(before.source,sourceRecord(),"Current final release source");
  requireFinalOriginalSource(before.source.source);verifyRecord(plan.config,"Actual isolated release config");verifyRecord(plan.harness,"Actual installer harness");verifyRecord(receipt.actualHook,"Actual release hook");verifyRecord(receipt.actualRuntimeInclude,"Actual release runtime include");
  if(!eq(beforeNative.hook,receipt.actualHook)||!eq(beforeBundle.hook,receipt.actualHook)||!eq(afterBundle.hook,receipt.actualHook)||!eq(beforeBundle.runtimeInclude,receipt.actualRuntimeInclude)||!eq(afterBundle.runtimeInclude,receipt.actualRuntimeInclude))fail("The bundle used another release hook");
  knownUnchanged(before.knownT20,afterBundle.knownT20);knownUnchanged(before.knownT19,afterBundle.knownT19);
  ownedWork(artifacts.directory);
  const bare=verifyRecord(artifacts.bare.frozen,"Frozen bare release EXE"),packaged=verifyRecord(artifacts.packaged.frozen,"Frozen actual NSIS packaged EXE"),installer=verifyRecord(artifacts.installer.frozen,"Frozen actual release installer");
  if(bare.path!==join(artifacts.directory,"bare-"+INSTALLER_IDENTITY.mainBinaryName+".exe")||packaged.path!==join(artifacts.directory,"nsis-packaged-"+INSTALLER_IDENTITY.mainBinaryName+".exe")||installer.path!==join(artifacts.directory,"new-"+receipt.version+"-release-setup.exe")||artifacts.bare.source.path!==join(recipe.artifactDirectory,INSTALLER_IDENTITY.mainBinaryName+".exe")||dirname(artifacts.installer.source.path)!==join(recipe.artifactDirectory,"bundle","nsis")||!basename(artifacts.installer.source.path).toLowerCase().endsWith(".exe"))fail("Frozen release artifacts do not belong to the actual target");
  for(const pair of [artifacts.bare,artifacts.installer])if(pair.source.sha256!==pair.frozen.sha256||pair.source.bytes!==pair.frozen.bytes)fail("The actual release artifact differs from its frozen copy");
  verifyRecord(artifacts.packagedObservation,"Actual NSIS compile-time observation");const observed=readJson(artifacts.packagedObservation.path);
  verifyRecord(receipt.actualCallbackBinding,"Actual immutable NSIS callback binding");
  const callback=validateNsisCallbackBinding(receipt.actualCallbackBinding.path,observed.actual.path,bare.path,packaged.path);
  if(!eq(observed.binding,{repository,record:receipt.actualCallbackBinding,plan:receipt.plan,harness:plan.harness})||!eq(callback.binding.source,beforeBundle.source)||!eq(callback.binding.hook,receipt.actualHook)||!eq(callback.binding.runtimeInclude,receipt.actualRuntimeInclude))fail("The actual compile-time callback belongs to a different repository/plan/harness/build");
  if(!eq(observed,artifacts.packaged)||observed.bare.sha256!==bare.sha256||observed.actual.path!==artifacts.bare.source.path||observed.actual.sha256!==packaged.sha256)fail("The actual packaged observation is not this exact release artifact");
  const expected=expectedNsisPackagedBytes(readFileSync(bare.path));if(!readFileSync(packaged.path).equals(expected.bytes)||!eq(observed.marker.changedBytes,expected.changed)||observed.marker.offset!==expected.offset)fail("The actual packaged release bytes do not match the pinned marker contract");
  if(!Object.keys(artifacts.runtime).some(name=>name.toLowerCase()==="directml.dll"))fail("Release DirectML runtime is missing");
  const runtime={};
  for(const [name,item] of Object.entries(artifacts.runtime)) {
    if(item.source.path!==join(recipe.artifactDirectory,name)||item.frozen.path!==join(artifacts.directory,name)||item.source.sha256!==item.frozen.sha256||item.source.bytes!==item.frozen.bytes)fail("Release DLL provenance differs");
    runtime[name]=verifyRecord(item.frozen,"Frozen actual release "+name);
  }
  return {record,receipt,old,installer,bare,actualPackaged:packaged,runtime,nativeExecuted:false,installerExecuted:false};
}
export async function main(args=process.argv.slice(2)) {
  if(args[0]==="--prepare"&&args.length===2)return prepareInstallerBuild(readJson(args[1]));
  if(args[0]==="--build"&&args.length===2)return recordReleaseInstallerBuild(args[1]);
  if(args[0]==="--capture-nsis"&&args.length===5)return captureActualPackagedExe(args[2],args[3],args[4],args[1]);
  if(args[0]==="--check-build"&&args.length===2)return checkReleaseInstallerBuild(args[1]);
  fail("node e2e/spec78-combination-installer.mjs --prepare <input.json> | --build <prepared-plan.json> | --capture-nsis <immutable-binding.json> <actual.exe> <bare.exe> <new-owned.exe>");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{console.log(JSON.stringify(await main()));}catch(error){console.error(error);process.exitCode=1;}
}
