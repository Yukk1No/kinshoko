// T20 orchestration. Preparation is offline. Native execution requires a frozen final source,
// complete final-original stage, root's exact manifest grant and an unused isolated fixture.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCombinationFixture, sha256 } from "./spec78-combination-fixture.mjs";
import { CombinationDriver } from "./spec78-combination-driver.mjs";
import { CombinationWorkflow } from "./spec78-combination-workflow.mjs";
import { combinedBackups } from "./spec78-combination-backup.mjs";
import { eagleReimportCombination } from "./spec78-combination-eagle.mjs";
import { sealedTransferBoundaries } from "./spec78-combination-sealed.mjs";
import { restartAndOffline, blankEnvironment } from "./spec78-combination-lifecycle.mjs";
import { IDENTIFIER, readJson, ownedWork, fileRecord, recordAttributedBuild, freezeBuild, makeNativePlan, checkNativePlan, sourceRecord, knownFolderState, preserveKnownFolder, restoreKnownFolder } from "./spec78-combination-preflight.mjs";

const usage="node e2e/spec78-combination.mjs --prepare <new owned directory> | --config <owned config path> | --build <build-input.json> | --freeze <config> <new freeze> <successful-build-receipt> | --plan <plan-input.json> | --known-folders <owned output.json> | --run <native-plan.json> <root-grant-id>";
function saveNew(path,value) {ownedWork(dirname(resolve(path)));if(existsSync(path))throw Error("Preserve the existing output: "+path);mkdirSync(dirname(resolve(path)),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2));}
export async function runCombined(planPath,desktopGrant) {
  if(!desktopGrant?.trim())throw Error("Native execution requires root's new exclusive desktop grant for this exact plan");
  const plan=readJson(planPath),fixture=checkNativePlan(plan);
  // The final T17 source has not yet been merged when this preparation was written.
  // Fail before boot rather than recording a partial old-EXE run as completed combination.
  const originalPath=join(dirname(fileURLToPath(import.meta.url)),"spec78-combination-original.mjs");
  if(!existsSync(originalPath))throw Error("Final T17 original-crop/copy stage is still unprepared; no native process started");
  const {originalCombination}=await import(pathToFileURL(originalPath).href);
  if(typeof originalCombination!=="function")throw Error("Missing final public originalCombination stage");
  const work=ownedWork(join(fixture.root,"native"));
  if(existsSync(work))throw Error("Native round already exists; retain it and use a fresh fixture/plan");
  mkdirSync(work,{recursive:true});
  const before=preserveKnownFolder(work),d=new CombinationDriver({application:plan.application.path,edgeDriver:plan.edgeDriver.path,tauriDriver:plan.tauriDriver.path,port:plan.port,work,data:join(work,"app-data"),profile:join(work,"webview")});
  const workflow=new CombinationWorkflow(d,fixture),report={kind:"spec78-t20-combined-run",status:"running",startedAt:new Date().toISOString(),plan:fileRecord(planPath),desktopGrant,buildSource:plan.build.source,buildTree:plan.build.tree,observationSource:sourceRecord(),application:plan.application,runtime:plan.runtime,buildAttribution:plan.build.buildAttribution,config:plan.build.config,fixture:fileRecord(plan.fixture.path),knownFolderBefore:before,mainSession:null,lifecycles:null,installer:"not-executed-by-this-harness",prototype:"not-executed-by-this-harness",windows10:"unverified-accepted-by-owner",fullT20Acceptance:false};
  try {
    await d.boot();report.mainSession=d.session;
    report.environment=await d.exec("return {userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},outer:{width:outerWidth,height:outerHeight},dpr:devicePixelRatio,screen:{width:screen.width,height:screen.height,colorDepth:screen.colorDepth,pixelDepth:screen.pixelDepth},timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};");
    d.assert(await d.invoke("safe_mode")===true,"isolated final formal program begins with global safe mode on");
    await workflow.registerAndMigrate();await workflow.importAndCurate();await workflow.sourceActions();await workflow.latePickerAndRules();await workflow.fixedImportOwner();
    await eagleReimportCombination(workflow);
    await originalCombination(workflow,plan);
    await workflow.strictAdultAndConsent();await sealedTransferBoundaries(workflow);await combinedBackups(workflow);await workflow.runtimeAndUpdateUI();
    report.mainSessionCompletedAt=new Date().toISOString();report.continuousMain={sessionId:report.mainSession,assertions:[...d.assertions],state:structuredClone(workflow.state)};
    await restartAndOffline(workflow);report.lifecycles={normalRestartAndOffline:structuredClone(workflow.state.lifecycle)};
    report.blank=await blankEnvironment(workflow,plan);report.lifecycles.blank=report.blank;
    report.status="verified-combined-native-flow";report.fullT20Acceptance=false;
  } catch(error) {
    report.status="failed";report.error=String(error);report.failedPhase=workflow.state.phase;process.exitCode=1;
    if(d.session){await d.screenshot("failure.png").catch(()=>{});await d.exec("return document.documentElement.outerHTML;").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});}throw error;
  } finally {
    report.cleanupErrors=[];
    try{await d.cleanup();}catch(error){report.cleanupErrors.push({step:"owned-process-cleanup",error:String(error)});}
    report.finishedAt=new Date().toISOString();report.assertions=d.assertions;report.workflow=workflow.state;
    if(d.release?.released===true){try{report.knownFolderRestoration=restoreKnownFolder(before,work);}catch(error){report.cleanupErrors.push({step:"restore-exact-test-known-folder",error:String(error)});}}
    else{report.knownFolderRestoration={restored:false,reason:"Exact app/profile/drivers/ports release is unconfirmed. Before bytes and current settings remain preserved."};report.cleanupErrors.push({step:"skip-known-folder-restore-while-release-unconfirmed",release:d.release});}
    try{report.afterSource=sourceRecord();report.knownFolderAfter=knownFolderState();}catch(error){report.cleanupErrors.push({step:"after-source-and-path-observation",error:String(error)});}
    if(report.cleanupErrors.length){report.status="failed-cleanup";process.exitCode=1;}
    writeFileSync(join(work,"result.json"),JSON.stringify(report,null,2));
  }
  return report;
}
export async function main(args=process.argv.slice(2)) {
  const [action,...rest]=args;
  if(action==="--prepare"&&rest.length===1){const fixture=createCombinationFixture(rest[0]);return {status:"offline-fixture-prepared",path:join(fixture.root,"fixture.json"),sha256:sha256(readFileSync(join(fixture.root,"fixture.json"))),nativeExecuted:false};}
  if(action==="--config"&&rest.length===1){const base=readJson("src-tauri/tauri.conf.json");const config={...base,productName:"Kinshoko T20 Combination Probe",identifier:IDENTIFIER,build:{...base.build,devUrl:null,beforeBuildCommand:null,beforeDevCommand:null,frontendDist:resolve("dist")},bundle:{...base.bundle,active:false}};saveNew(rest[0],config);return {status:"isolated-native-config-prepared",file:fileRecord(rest[0]),nativeExecuted:false};}
  if(action==="--build"&&rest.length===1)return recordAttributedBuild(readJson(rest[0]));
  if(action==="--freeze"&&rest.length===3)return freezeBuild(...rest);
  if(action==="--plan"&&rest.length===1)return makeNativePlan(readJson(rest[0]));
  if(action==="--known-folders"&&rest.length===1){const result={at:new Date().toISOString(),t20:knownFolderState(),retainedT19:knownFolderState("dev.kinshoko.spec78t19upgrade"),nativeExecuted:false};saveNew(rest[0],result);return result;}
  if(action==="--run"&&rest.length===2)return runCombined(...rest);
  throw Error(usage);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {const result=await main();console.log(JSON.stringify(result));}catch(error){console.error(error);process.exitCode=1;}
}
