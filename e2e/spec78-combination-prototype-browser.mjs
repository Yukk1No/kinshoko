// T20 owned prototype browser/server lifecycle. Import-safe.
// --run requires a fresh root exclusive grant for one exact plan. Preparation never
// launches Vite, a browser or driver, observes CIM/ports, or changes a human profile.
import {spawn,spawnSync} from "node:child_process";
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {CombinationDriver,until} from "./spec78-combination-driver.mjs";
import {compareAcceptedPrototype,localInventory} from "./spec78-combination-prototype.mjs";
import {fileRecord,ownedWork,readJson,sameSnapshot,sourceRecord,verifyRecord} from "./spec78-combination-preflight.mjs";

export const PROTOTYPE_PORTS={driver:4634,vite:4186};
const norm=value=>String(value??"").replaceAll("\\","/").toLowerCase();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Error(message);};
const sameInstance=(a,b)=>a?.pid===b?.pid&&a?.created===b?.created&&norm(a?.executable)===norm(b?.executable);
function inDirectory(path,root){const name=relative(resolve(root),resolve(path));return name!==""&&!isAbsolute(name)&&name!==".."&&!name.startsWith(".."+sep);}
export function commandTokens(command) {
  return [...String(command??"").matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map(match=>match[0].replaceAll('"',""));
}
function argument(tokens,name,value) {
  const values=[];
  for(let index=0;index<tokens.length;index++) {
    if(tokens[index]===name)values.push(tokens[index+1]);
    else if(tokens[index].startsWith(name+"="))values.push(tokens[index].slice(name.length+1));
  }
  return values.length===1&&values[0]!==undefined&&norm(values[0])===norm(value);
}
function exactIdentity(item) {
  return Number.isSafeInteger(item?.pid)&&item.pid>0&&Number.isSafeInteger(item.parentPid)&&item.parentPid>=0&&typeof item.created==="string"&&Number.isFinite(Date.parse(item.created))&&typeof item.executable==="string"&&isAbsolute(item.executable);
}
// Pure identity classifier. A basename/old PID or profile-prefix match never owns a process.
export function classifyPrototypeProcesses(snapshot,binding,historical=[]) {
  if(!Array.isArray(snapshot?.processes)||!Array.isArray(snapshot?.ports))fail("A successful complete CIM/port observation is required");
  const current=snapshot.processes,selected=new Map(),spawned=binding.spawned??[];
  for(const prior of spawned) {
    const item=current.find(process=>process.pid===prior.pid);
    if(item&&!sameInstance(item,prior))fail("The spawned server/driver PID was reused or its exact identity changed");
  }
  for(const item of current) {
    const tokens=commandTokens(item.commandLine),path=norm(item.executable),prior=historical.find(old=>sameInstance(item,old));
    let ownership=null;
    if(spawned.some(old=>sameInstance(item,old)))ownership="initial-spawned-path-pid-creation";
    else if(prior)ownership="previously-observed-exact-instance";
    else if(path===norm(binding.edgeDriver)&&argument(tokens,"--port",binding.ports.driver))ownership="exact-edge-driver-path-and-port";
    else if(path===norm(binding.node)&&tokens.some(token=>norm(token)===norm(binding.viteCli))&&argument(tokens,"--config",binding.viteConfig)&&argument(tokens,"--port",binding.ports.vite))ownership="exact-owned-vite-cli-config-and-port";
    else if(argument(tokens,"--user-data-dir",binding.profile)) {
      if(path!==norm(binding.browserBinary))fail("The exact owned profile is used by an unexpected executable");
      ownership="exact-browser-path-and-profile-argument";
    }
    if(ownership) {
      if(!exactIdentity(item))fail("Owned process observation lacks exact PID/path/creation");
      selected.set(item.pid,{...item,ownership});
    }
  }
  for(const item of selected.values()) {
    const parent=selected.get(item.parentPid);
    if(parent&&Date.parse(item.created)<Date.parse(parent.created))fail("Owned process ancestry has an earlier child creation time");
  }
  for(let pass=0;pass<=current.length;pass++) {
    let changed=false;
    for(const item of current) {
      if(selected.has(item.pid)||!selected.has(item.parentPid))continue;
      const parent=selected.get(item.parentPid);
      if(!exactIdentity(item)||Date.parse(item.created)<Date.parse(parent.created))fail("Owned descendant identity/creation is unconfirmed");
      const tokens=commandTokens(item.commandLine),hasProfile=tokens.some(token=>token==="--user-data-dir"||token.startsWith("--user-data-dir="));
      if((hasProfile||norm(parent.executable)===norm(binding.edgeDriver)&&norm(item.executable)===norm(binding.browserBinary))&&!argument(tokens,"--user-data-dir",binding.profile))fail("An owned descendant has an unconfirmed or conflicting browser profile");
      if(!inDirectory(item.executable,dirname(binding.browserBinary))&&!inDirectory(item.executable,binding.dependencies))fail("Unexpected executable descended from an owned browser/server; preserve unconfirmed release");
      selected.set(item.pid,{...item,ownership:"verified-current-parent-exact-path-descendant"});changed=true;
    }
    if(!changed)break;if(pass===current.length)fail("Unexpected cyclic process ancestry");
  }
  const ports=snapshot.ports.filter(port=>[binding.ports.driver,binding.ports.vite].includes(port.port));
  for(const port of ports)if(!Number.isSafeInteger(port.pid)||!selected.has(port.pid))fail("A reserved prototype listener belongs to an unowned process");
  return {processes:[...selected.values()],ports,checkedAt:snapshot.checkedAt,observedProcessCount:current.length};
}
export const browserObservationScript=String.raw`
$ErrorActionPreference='Stop'
$moduleRoot=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
Import-Module (Join-Path $moduleRoot 'CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
Import-Module (Join-Path $moduleRoot 'NetTCPIP\NetTCPIP.psd1') -ErrorAction Stop
$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$processes=@($all | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;executable=$_.ExecutablePath;created=$(if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null});commandLine=$_.CommandLine} })
$ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -in 4634,4186} | ForEach-Object { @{port=[int]$_.LocalPort;address=$_.LocalAddress;pid=[int]$_.OwningProcess} })
@{processes=$processes;ports=$ports;checkedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5 -Compress
`;
export const browserTerminationScript=String.raw`
$ErrorActionPreference='Stop'
$moduleRoot=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
Import-Module (Join-Path $moduleRoot 'CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
$expected=@(ConvertFrom-Json $env:KINSHOKO_T20_BROWSER_TERMINATE)
$terminated=@();$alreadyEnded=@()
foreach($prior in $expected) {
 $item=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[string][uint32]$prior.pid) -ErrorAction Stop | Select-Object -First 1
 if($null -eq $item){$alreadyEnded+=@{pid=$prior.pid;created=$prior.created;reason='exact-instance-ended'};continue}
 if($item.CreationDate.ToUniversalTime().ToString('o') -ne $prior.created -or $item.ExecutablePath -ne $prior.executable){throw 'PID/path/creation changed before exact termination'}
 try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop } catch {
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[string][uint32]$prior.pid) -ErrorAction Stop | Select-Object -First 1
  if($null -ne $current){throw};$alreadyEnded+=@{pid=$prior.pid;created=$prior.created;reason='exited-during-exact-stop'};continue
 }
 $terminated+=@{pid=$prior.pid;created=$prior.created;executable=$prior.executable}
}
@{terminated=$terminated;alreadyEnded=$alreadyEnded} | ConvertTo-Json -Depth 4 -Compress
`;
function writeNew(path,value) {if(existsSync(path))fail("Preserve the prior prototype plan/result");mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2),{flag:"wx"});}
function inputUnchanged(input) {
  verifyRecord(input.packet,"Actual same-session public packet");
  for(const [name,record] of Object.entries(input.code.files))verifyRecord({...record,path:join(input.mirror,name)},"Accepted mirror code");
  verifyRecord(input.dependencies.viteCli,"Actual offline Vite CLI");
  verifyRecord(input.dependencies.vitePackage,"Actual offline Vite package");
  if(!same(input.local,localInventory(join(input.mirror,".local")))||!same(input.historicalLocalBefore,localInventory()))fail("Fresh inputs or historical .local changed");
  return input;
}
export function validatePrototypeBrowserPlan(plan,input) {
  if(plan.kind!=="spec78-t20-owned-prototype-browser-plan"||plan.status!=="prepared-not-run"||!same(plan.ports,PROTOTYPE_PORTS))fail("Expected an exact unused owned prototype browser plan");
  const expected={node:plan.node.path,browserBinary:plan.browser.path,edgeDriver:plan.edgeDriver.path,viteCli:input.dependencies.viteCli.path,viteConfig:join(input.mirror,"vite.config.ts"),dependencies:realpathSync(input.dependencies.path),profile:input.browserProfile,ports:PROTOTYPE_PORTS,spawned:[]};
  if(!same(plan.binding,expected)||plan.profile!==input.browserProfile||norm(plan.node.path)!==norm(process.execPath))fail("The browser binding differs from its exact recorded runtime, mirror, dependencies or profile");
  ownedWork(plan.work);ownedWork(plan.profile);
  if(plan.nativeExecuted!==false||plan.browserExecuted!==false||plan.fullT20Acceptance!==false)fail("A browser preparation cannot claim prior execution or acceptance");
  return plan;
}
export function planPrototypeBrowser({inputPath,browserBinary,edgeDriver,output}) {
  const input=inputUnchanged(readJson(inputPath)),path=resolve(output);ownedWork(dirname(path));
  if(input.kind!=="spec78-t20-prototype-input"||input.status!=="prepared-not-run"||input.prototypeExecuted!==false||input.validation.exactPrototypeOrder!==true)fail("A fresh complete actual public prototype input is required");
  const source=sourceRecord();sameSnapshot(input.source,source,"Prototype input source");
  const work=ownedWork(join(dirname(path),"prototype-browser-run"));
  if(existsSync(work)||existsSync(input.browserProfile))fail("This browser round needs an unused work directory and entirely new profile");
  const ps=join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
  const plan={kind:"spec78-t20-owned-prototype-browser-plan",status:"prepared-not-run",at:new Date().toISOString(),source,input:fileRecord(inputPath),work,profile:input.browserProfile,ports:PROTOTYPE_PORTS,browser:fileRecord(browserBinary),edgeDriver:fileRecord(edgeDriver),node:fileRecord(process.execPath),powershell:fileRecord(ps),binding:{node:resolve(process.execPath),browserBinary:resolve(browserBinary),edgeDriver:resolve(edgeDriver),viteCli:input.dependencies.viteCli.path,viteConfig:join(input.mirror,"vite.config.ts"),dependencies:realpathSync(input.dependencies.path),profile:input.browserProfile,ports:PROTOTYPE_PORTS,spawned:[]},harness:{browser:fileRecord("e2e/spec78-combination-prototype-browser.mjs"),protocol:fileRecord("e2e/spec78-combination-driver.mjs"),comparison:fileRecord("e2e/spec78-combination-prototype.mjs")},nativeExecuted:false,browserExecuted:false,fullT20Acceptance:false};
  validatePrototypeBrowserPlan(plan,input);writeNew(path,plan);return plan;
}
export class OwnedPrototypeBrowser {
  constructor(plan,input) {
    this.plan=plan;this.input=input;this.work=plan.work;this.profile=plan.profile;this.binding=structuredClone(plan.binding);
    this.url="http://127.0.0.1:"+plan.ports.driver;this.session=null;this.trace=[];this.assertions=[];this.ownedProcesses=[];this.release=null;this.children=[];this.logs=[];this.process=null;
  }
  observeOwned() {
    const observed=spawnSync(this.plan.powershell.path,["-NoProfile","-NonInteractive","-Command",browserObservationScript],{windowsHide:true,encoding:"utf8"});
    if(observed.status!==0||observed.error)fail("Exact prototype CIM/listener query failed: "+observed.stderr);
    const snapshot=JSON.parse(observed.stdout.trim().replace(/^\uFEFF/,""));
    // The full CIM result is used in memory only. Reports contain the filtered owned
    // identities; unrelated human process command lines are never persisted.
    return classifyPrototypeProcesses(snapshot,this.binding,this.ownedProcesses);
  }
  initialSpawn(child,path,label) {
    const state=this.observeOwned(),item=state.processes.find(process=>process.pid===child.pid);
    if(!item||norm(item.executable)!==norm(path)||!item.created||child.exitCode!==null||child.signalCode!==null)fail("The initially spawned "+label+" is not a live exact executable/PID/creation instance");
    this.binding.spawned.push(item);this.rememberOwned(state);this.record("prototype-initial-spawn",{label,item});return item;
  }
  spawnOwned(label,executable,args,cwd) {
    const out=openSync(join(this.work,label+"-stdout.txt"),"wx"),err=openSync(join(this.work,label+"-stderr.txt"),"wx");
    this.logs.push(out,err);
    const child=spawn(executable,args,{cwd,windowsHide:true,stdio:["ignore",out,err]});this.children.push(child);
    child.on("error",error=>this.record("spawn-error",{label,error:String(error)}));
    this.initialSpawn(child,executable,label);return child;
  }
  async boot() {
    const before=this.observeOwned();this.assert(before.processes.length===0&&before.ports.length===0,"prototype exact server/driver/profile/ports are unused before boot",before);
    if(existsSync(this.profile))fail("Never reuse or clear an existing browser profile");
    const server=this.spawnOwned("vite",this.plan.node.path,[this.binding.viteCli,"--config",this.binding.viteConfig,"--host","127.0.0.1","--port",String(this.plan.ports.vite),"--strictPort"],this.input.mirror);
    await until("owned Vite listener ready",async()=>{if(server.exitCode!==null||server.signalCode!==null)fail("Owned Vite exited during startup");const state=this.observeOwned();this.rememberOwned(state);return state.ports.some(port=>port.port===this.plan.ports.vite&&port.pid===server.pid)&&await fetch("http://127.0.0.1:"+this.plan.ports.vite).then(response=>response.ok);});
    const driver=this.spawnOwned("edge-driver",this.plan.edgeDriver.path,["--port="+this.plan.ports.driver],this.work);
    await until("owned Edge driver listener ready",async()=>{if(driver.exitCode!==null||driver.signalCode!==null)fail("Owned Edge driver exited during startup");const state=this.observeOwned();this.rememberOwned(state);return state.ports.some(port=>port.port===this.plan.ports.driver&&port.pid===driver.pid)&&await fetch(this.url+"/status").then(response=>response.ok);});
    const packet=readJson(this.input.packet.path),created=await this.request("POST","/session",{capabilities:{alwaysMatch:{browserName:"MicrosoftEdge","ms:edgeOptions":{binary:this.plan.browser.path,args:["--headless=new","--no-first-run","--no-default-browser-check","--user-data-dir="+this.profile,"--force-device-scale-factor="+packet.environment.dpr,"--window-size=1280,800"]}}}});
    if(!created?.sessionId)fail("Actual owned Edge session response has no session ID");
    this.session="/session/"+created.sessionId;this.record("actual-prototype-capabilities",created.capabilities);
    const state=this.observeOwned();this.rememberOwned(state);
    const roots=state.processes.filter(process=>process.ownership==="exact-browser-path-and-profile-argument"&&process.parentPid===driver.pid);
    this.assert(roots.length===1,"one new actual Edge root belongs to the exact spawned driver and fresh profile",roots);
    await this.request("POST",this.session+"/url",{url:"http://127.0.0.1:"+this.plan.ports.vite});
    this.assert(await this.exec("return location.origin===arguments[0];",["http://127.0.0.1:"+this.plan.ports.vite]),"actual browser loads the owned accepted-prototype Vite origin");
  }
  terminateOwned(expected,label) {
    if(expected.some(item=>!exactIdentity(item)))fail("Exact prototype termination identities are incomplete");
    const result=spawnSync(this.plan.powershell.path,["-NoProfile","-NonInteractive","-Command",browserTerminationScript],{windowsHide:true,encoding:"utf8",env:{...process.env,KINSHOKO_T20_BROWSER_TERMINATE:JSON.stringify([...expected].reverse())}});
    const receipt={status:result.status,error:result.error?String(result.error):null,stdout:result.stdout,stderr:result.stderr};this.record(label,receipt);
    if(result.status!==0||result.error)fail("Exact prototype process termination failed: "+result.stderr);
    return receipt;
  }
  async screenshot(name) {
    const path=join(this.work,name);if(existsSync(path))fail("Preserve the actual prototype screenshot");
    writeFileSync(path,Buffer.from(await this.request("GET",this.session+"/screenshot"),"base64"),{flag:"wx"});
  }
  async finish() {
    try{return await this.cleanup();}
    finally{for(const fd of this.logs)closeSync(fd);this.logs=[];}
  }
}
// Share only the reviewed public WebDriver protocol and exact release state loop.
// Native boot, tray helpers, application/window commands and profile rules are not inherited.
for(const name of ["request","exec","async","find","click","enabled","key","record","assert","save","rememberOwned","waitReleased","cleanup"]) {
  Object.defineProperty(OwnedPrototypeBrowser.prototype,name,{value:CombinationDriver.prototype[name]});
}
export async function runPrototypeBrowser(planPath,rootGrant) {
  if(!rootGrant?.trim())fail("A new exact exclusive root browser/server grant is required");
  const plan=readJson(planPath),input=inputUnchanged(readJson(plan.input.path));
  validatePrototypeBrowserPlan(plan,input);
  verifyRecord(plan.input,"Actual prototype input");
  for(const [name,record] of Object.entries({browser:plan.browser,edgeDriver:plan.edgeDriver,node:plan.node,powershell:plan.powershell,...plan.harness}))verifyRecord(record,"Frozen prototype runtime/helper "+name);
  sameSnapshot(plan.source,sourceRecord(),"Actual prototype source");sameSnapshot(input.source,plan.source,"Prototype prepared input");
  if(existsSync(plan.work)||existsSync(plan.profile))fail("Use a new run/profile; preserve any existing browser evidence");
  ownedWork(plan.work);ownedWork(plan.profile);mkdirSync(plan.work,{recursive:true});
  const d=new OwnedPrototypeBrowser(plan,input),report={kind:"spec78-t20-owned-prototype-browser-run",status:"running",startedAt:new Date().toISOString(),rootGrant,plan:fileRecord(planPath),source:plan.source,input:plan.input,browser:plan.browser,edgeDriver:plan.edgeDriver,profile:plan.profile,historicalLocalBefore:localInventory(),comparison:null,cleanup:null,humanAcceptance:"unverified",fullT20Acceptance:false};
  const save=()=>writeFileSync(join(plan.work,"result.json"),JSON.stringify(report,null,2));save();
  try {
    await d.boot();report.comparison=await compareAcceptedPrototype(d,plan.input.path,rootGrant);report.status="observed-same-input-baseline-tasks";report.browserExecuted=true;
  }catch(error){report.status="failed";report.error=String(error);process.exitCode=1;if(d.session)await d.screenshot("failure.png").catch(shotError=>d.record("failure-screenshot-error",{error:String(shotError)}));throw error;}
  finally {
    try{report.cleanup=await d.finish();}catch(error){report.cleanup=d.release;report.cleanupError=String(error);report.status="failed-cleanup";process.exitCode=1;}
    try{report.historicalLocalAfter=localInventory();if(!same(report.historicalLocalBefore,report.historicalLocalAfter))fail("Historical .local changed");}catch(error){report.historicalLocalError=String(error);report.status="failed-historical-input-attribution";process.exitCode=1;}
    try{report.sourceAfter=sourceRecord();sameSnapshot(plan.source,report.sourceAfter,"Source during prototype comparison");}catch(error){report.sourceError=String(error);report.status="failed-source-attribution";process.exitCode=1;}
    report.assertions=d.assertions;report.finishedAt=new Date().toISOString();save();
  }
  return report;
}
export async function main(args=process.argv.slice(2)) {
  if(args[0]==="--plan"&&args.length===2)return planPrototypeBrowser(readJson(args[1]));
  if(args[0]==="--run"&&args.length===3)return runPrototypeBrowser(args[1],args[2]);
  fail("node e2e/spec78-combination-prototype-browser.mjs --plan <input.json> | --run <plan.json> <root-exclusive-grant>");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{console.log(JSON.stringify(await main()));}catch(error){console.error(error);process.exitCode=1;}
}
