// Actual T20 clean and old 0.1.0 -> new 0.1.2 release UPDATE lifecycle.
// Import-safe. Only --run with a new exact root grant can observe Windows or install.
// Old top-level private-upgrade.mjs is a source reference, never an imported runner.
import {spawn,spawnSync} from "node:child_process";
import {closeSync,constants,copyFileSync,existsSync,mkdirSync,openSync,readFileSync,readdirSync,rmdirSync,statSync,unlinkSync,writeFileSync} from "node:fs";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {release as windowsRelease} from "node:os";
import {deflateSync} from "node:zlib";
import {fileURLToPath,pathToFileURL} from "node:url";
import {CombinationDriver,until,untilStrict} from "./spec78-combination-driver.mjs";
import {CombinationWorkflow} from "./spec78-combination-workflow.mjs";
import {browserObservationScript,browserTerminationScript,commandTokens} from "./spec78-combination-prototype-browser.mjs";
import {INSTALLER_IDENTITY,checkReleaseInstallerBuild} from "./spec78-combination-installer.mjs";
import {fileRecord,knownFolderState,knownUnchanged,ownedWork,readJson,sameSnapshot,sourceRecord,verifyRecord} from "./spec78-combination-preflight.mjs";
import {sha256} from "./spec78-combination-fixture.mjs";

const self=fileURLToPath(import.meta.url),repo=resolve(dirname(self),".."),identity=INSTALLER_IDENTITY.identifier;
const fail=message=>{throw Error(message);},eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const norm=value=>String(value??"").replaceAll("\\","/").replace(/\/+$/,"").toLowerCase();
const sameInstance=(a,b)=>a?.pid===b?.pid&&a?.created===b?.created&&norm(a?.executable)===norm(b?.executable);
const exact=item=>Number.isSafeInteger(item?.pid)&&item.pid>0&&Number.isSafeInteger(item.parentPid)&&item.parentPid>=0&&typeof item.created==="string"&&Number.isFinite(Date.parse(item.created))&&typeof item.executable==="string"&&isAbsolute(item.executable);
function boundedBirth(item){const birth=item?.birth,created=Date.parse(item?.created);return exact(item)&&birth&&[birth.startedAt,birth.returnedAt,birth.observedAt].every(Number.isSafeInteger)&&birth.startedAt<=created&&created<=birth.returnedAt&&birth.returnedAt<=birth.observedAt&&birth.childPid===item.pid&&birth.creatorPid===item.parentPid&&birth.creatorPid===process.pid&&norm(birth.executable)===norm(item.executable);}
function writeNew(path,value){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value,null,2),{flag:"wx"});}
function trackedSelf(){if(self!==join(repo,"e2e","spec78-combination-installation-lifecycle.mjs")||resolve(".")!==repo)fail("Run only the frozen tracked lifecycle from its actual repository");}
function inside(path,root){const name=relative(resolve(root),resolve(path));return name===""||!isAbsolute(name)&&name!==".."&&!name.startsWith(".."+sep);}
function argument(tokens,key){const values=[];for(let i=0;i<tokens.length;i++){if(tokens[i]===key)values.push(tokens[i+1]);else if(tokens[i].startsWith(key+"="))values.push(tokens[i].slice(key.length+1));}return values.length===1?values[0]:null;}
function profileMatches(item,profile){const value=argument(commandTokens(item.commandLine),"--user-data-dir");return !!value&&isAbsolute(value)&&inside(norm(value),norm(profile));}
const relevant=item=>({pid:item.pid,parentPid:item.parentPid,executable:item.executable,created:item.created});
// This pure function starts from captured ChildProcess births. A matching install
// path, profile or port is never sufficient to own or close another process.
export function selectSpawnLineage(snapshot,spawned,historical=[],allowed=null) {
  if(!Array.isArray(snapshot?.processes)||!Array.isArray(snapshot?.ports))fail("A complete successful process/listener query is required");
  const selected=new Map(),current=snapshot.processes;
  const checkedAt=Date.parse(snapshot.checkedAt);if(!Number.isFinite(checkedAt)||checkedAt>Date.now())fail("Process observation time is unconfirmed or in the future");
  for(const root of spawned){if(!boundedBirth(root))fail("Captured bounded ChildProcess birth identity is incomplete");const item=current.find(value=>value.pid===root.pid);if(item&&!sameInstance(item,root))fail("Captured root PID was reused; leave the new process untouched");}
  for(const item of current){
    const root=spawned.find(value=>sameInstance(item,value)),prior=historical.find(value=>sameInstance(item,value));
    if(root)selected.set(item.pid,{...item,rootPid:root.pid,rootCreated:root.created,rootExecutable:root.executable,ownership:"captured-this-round-spawn"});
    else if(prior){const origin=spawned.find(value=>value.pid===prior.rootPid&&value.created===prior.rootCreated&&norm(value.executable)===norm(prior.rootExecutable));if(!origin||!exact(item)||Date.parse(item.created)<Date.parse(origin.created))fail("Historical descendant lacks this round's verified birth proof");selected.set(item.pid,{...item,rootPid:origin.pid,rootCreated:origin.created,rootExecutable:origin.executable,ownership:"previously-verified-descendant"});}
  }
  for(let pass=0;pass<=current.length;pass++){
    let changed=false;
    for(const item of current){if(selected.has(item.pid)||!selected.has(item.parentPid))continue;const parent=selected.get(item.parentPid);if(!exact(item)||Date.parse(item.created)<Date.parse(parent.created)||Date.parse(item.created)>checkedAt||allowed&&!allowed.has(norm(item.executable)))fail("Descendant path/PID/creation is unconfirmed; preserve release failure: "+JSON.stringify({item:relevant(item),parent:relevant(parent)}));selected.set(item.pid,{...item,rootPid:parent.rootPid,rootCreated:parent.rootCreated,rootExecutable:parent.rootExecutable,ownership:"verified-current-parent"});changed=true;}
    if(!changed){for(const item of current){const parent=[...spawned,...historical].find(value=>value.pid===item.parentPid);if(!selected.has(item.pid)&&parent&&Date.parse(item.created)>=Date.parse(parent.created))fail("A previously unobserved orphan may belong to a ended spawn; release remains unconfirmed");}return [...selected.values()];}
  }
  fail("Unexpected cyclic process ancestry");
}
// r3: WebView2 starts %SystemRoot%\System32\conhost.exe under its own process. It is accepted only by
// exact system path, and only through the same verified parent/creation lineage as every descendant.
export const consoleHost=()=>join(process.env.SystemRoot??fail("SystemRoot is unknown"),"System32","conhost.exe");
// r4: the silent in-place uninstaller (_?=) can exit before the first process query sees it. Node's own
// ChildProcess then holds the only identity and its real exit. Accept that only when the snapshot taken
// after the exit holds no process that names this PID as parent and was created after the spawn began;
// such a child could be an unobserved descendant, so it fails instead.
export function exitedBeforeObservation(snapshot,spawned){
  if(!Array.isArray(snapshot?.processes)||!Number.isFinite(Date.parse(snapshot.checkedAt)))fail("A complete successful process query is required");
  if(!Number.isSafeInteger(spawned?.pid)||spawned.pid<=0||!Number.isSafeInteger(spawned.startedAt)||!Number.isSafeInteger(spawned.exitedAt)||spawned.exitedAt<spawned.startedAt||spawned.exit===null&&!spawned.signal)fail("Only an exited spawn with a recorded Node identity and exit qualifies");
  if(Date.parse(snapshot.checkedAt)<spawned.exitedAt)fail("The process query must follow the observed exit");
  if(snapshot.processes.some(item=>item.pid===spawned.pid))fail("The exited PID is present again; leave it untouched");
  const orphans=snapshot.processes.filter(item=>item.parentPid===spawned.pid&&!(Date.parse(item.created)<spawned.startedAt));
  if(orphans.length)fail("An exited-before-observation spawn has possible descendants: "+JSON.stringify(orphans.map(relevant)));
  return {pid:spawned.pid,startedAt:spawned.startedAt,returnedAt:spawned.returnedAt,exitedAt:spawned.exitedAt,exit:spawned.exit,signal:spawned.signal??null,checkedAt:snapshot.checkedAt,exitedBeforeObservation:true,descendants:[]};
}
export function classifyInstallationProcesses(snapshot,binding,historical=[]) {
  const allowed=new Set([binding.application,binding.tauriDriver,binding.edgeDriver,binding.webviewBinary,consoleHost()].map(norm)),processes=selectSpawnLineage(snapshot,binding.spawned??[],historical,allowed),selected=new Set(processes.map(item=>item.pid)),collisions=[];
  for(const item of processes)if(norm(item.executable)===norm(binding.webviewBinary)&&!profileMatches(item,binding.profile))fail("A descended WebView has an unconfirmed profile; do not close it or restore settings");
  for(const item of snapshot.processes){if(selected.has(item.pid))continue;const tokens=commandTokens(item.commandLine),path=norm(item.executable);let reason;
    if(path===norm(binding.application))reason="foreign-exact-installed-app";
    else if(basename(item.executable??"").toLowerCase()==="kinshoko-t19-upgrade.exe")reason="foreign-test-identity-app-path";
    else if(path===norm(binding.tauriDriver)&&argument(tokens,"--port")==="4630")reason="foreign-tauri-driver-port";
    else if(path===norm(binding.edgeDriver)&&argument(tokens,"--port")==="4631")reason="foreign-edge-driver-port";
    else if(profileMatches(item,binding.profile))reason="foreign-owned-profile";
    if(reason)collisions.push({...relevant(item),reason});
  }
  const ports=snapshot.ports.filter(item=>[4630,4631].includes(item.port));
  for(const port of ports)if(!selected.has(port.pid))collisions.push({pid:port.pid,port:port.port,reason:"foreign-reserved-listener"});
  return {processes,collisions,ports,checkedAt:snapshot.checkedAt};
}
export const installationObservationScript=browserObservationScript.replace("4634,4186","4630,4631");
export const registryObservationScript=String.raw`
$ErrorActionPreference='Stop'
$views=@([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)
$run=@();$uninstall=@()
foreach($view in $views){
 $cu=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
 try{
  $key=$cu.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run',$false)
  try{foreach($name in @('Kinshoko','Kinshoko T19 Upgrade Probe')){
   $exists=$null -ne $key -and $key.GetValueNames() -contains $name
   $run+=@{hive='HKCU';view=$view.ToString();name=$name;exists=$exists;kind=$(if($exists){$key.GetValueKind($name).ToString()}else{$null});value=$(if($exists){$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null})}
  }}finally{if($null -ne $key){$key.Dispose()}}
 }finally{$cu.Dispose()}
 foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
  try{$parent=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall',$false)
   try{if($null -ne $parent){foreach($name in $parent.GetSubKeyNames()){
    $key=$parent.OpenSubKey($name,$false)
    try{if($null -eq $key){throw 'Enumerated uninstall key became unavailable'}
     if($key.GetValue('DisplayName') -eq 'Kinshoko T19 Upgrade Probe'){
      $uninstall+=@{hive=$hive.ToString();view=$view.ToString();key=$name;DisplayName=$key.GetValue('DisplayName');DisplayVersion=$key.GetValue('DisplayVersion');InstallLocation=$key.GetValue('InstallLocation');DisplayIcon=$key.GetValue('DisplayIcon');UninstallString=$key.GetValue('UninstallString');QuietUninstallString=$key.GetValue('QuietUninstallString')}
     }
    }finally{if($null -ne $key){$key.Dispose()}}
   }}}finally{if($null -ne $parent){$parent.Dispose()}}
  }finally{$base.Dispose()}
 }
}
$cu=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
try{$key=$cu.OpenSubKey('Software\kinshoko\Kinshoko T19 Upgrade Probe',$false)
 try{$product=@{exists=$null -ne $key;values=@();subkeys=@()};if($null -ne $key){$product.values=@($key.GetValueNames()|ForEach-Object{@{name=$_;kind=$key.GetValueKind($_).ToString();value=$key.GetValue($_,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}});$product.subkeys=@($key.GetSubKeyNames())}}finally{if($null -ne $key){$key.Dispose()}}
}finally{$cu.Dispose()}
@{run=$run;uninstall=$uninstall;product=$product;checkedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 8 -Compress
`;
// The NSIS uninstaller keeps HKCU\Software\<manufacturer>\<product> (install-dir default value) unless
// the interactive "delete app data" box is ticked. Remove only that exact isolated key, and only when
// it holds nothing but this stage's install directory.
export const productKeyRemovalScript=String.raw`
$ErrorActionPreference='Stop'
$path='Software\kinshoko\Kinshoko T19 Upgrade Probe'
$cu=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
try{$key=$cu.OpenSubKey($path,$false);if($null -eq $key){'{"removed":false,"absent":true}';exit 0}
 try{$names=@($key.GetValueNames());$value=$key.GetValue('');if($names.Count -ne 1 -or $names[0] -ne '' -or $key.SubKeyCount -ne 0 -or $value -ne $env:KINSHOKO_T20_STAGE_INSTALL_DIR){throw 'Isolated product key is not exactly this stage install record; preserve it'}}finally{$key.Dispose()}
 $cu.DeleteSubKey($path);@{removed=$true;absent=$true;value=$value} | ConvertTo-Json -Compress
}finally{$cu.Dispose()}
`;
export const localDataScript=String.raw`
$ErrorActionPreference='Stop'
@{local=(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) $env:KINSHOKO_T20_IDENTIFIER);roaming=(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) $env:KINSHOKO_T20_IDENTIFIER)} | ConvertTo-Json -Compress
`;
export const installedVersionScript=String.raw`
$ErrorActionPreference='Stop'
$item=Get-Item -LiteralPath $env:KINSHOKO_T20_INSTALLED_EXE -ErrorAction Stop
$item.VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress
`;
export function registryPathValue(value){const text=String(value??"");if(!text.includes('"'))return text;const match=/^"([^"]+)"$/.exec(text);if(!match)fail("Unexpected quoting in an actual registry path value");return match[1];}
function powershell(plan,script,environment={}) {
  const result=spawnSync(plan.runtime.powershell.path,["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,encoding:"utf8",env:{...process.env,...environment}});
  if(result.status!==0||result.error)fail("Authoritative Windows query failed: "+result.stderr);
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,""));
}
export function requireReleasedSettingsBoundary({installerSettled,scopes}) {
  if(installerSettled!==true||!Array.isArray(scopes)||scopes.length!==2)fail("Settings restoration requires settled installers and both actual native scopes");
  for(const state of scopes)if(!state||state.unconfirmed||!Number.isFinite(Date.parse(state.checkedAt))||Date.parse(state.checkedAt)>Date.now()||!Array.isArray(state.processes)||!Array.isArray(state.ports)||!Array.isArray(state.collisions)||state.processes.length||state.ports.length||state.collisions.length)fail("Do not write KnownFolder settings while native release is unconfirmed");
  return true;
}
export function assertPreservedFields(before,after,label="saved user fields") {
  if(before===null||typeof before!=="object"){if(!Object.is(before,after))fail(label+" changed");return;}
  if(Array.isArray(before)){if(!Array.isArray(after)||before.length!==after.length)fail(label+" array changed");for(let i=0;i<before.length;i++)assertPreservedFields(before[i],after[i],label+"["+i+"]");return;}
  if(!after||typeof after!=="object")fail(label+" missing");
  for(const [key,value] of Object.entries(before)){if(!Object.hasOwn(after,key))fail(label+"."+key+" missing");assertPreservedFields(value,after[key],label+"."+key);}
}
export function validateSettingsAliases(state) {
  if(state.identifier!==identity||!state.requested||!state.resolved||norm(state.requestedResolvesTo)!==norm(state.resolved.path))fail("Expected actual requested/resolved T19 KnownFolder aliases");
  for(const name of ["requested","resolved"]){const item=state[name];if(!isAbsolute(item.path)||!norm(item.path).endsWith("/"+identity+"/settings.json")||typeof item.exists!=="boolean")fail("Only the exact isolated T19 settings file may be preserved or restored");}
  if(state.requested.exists!==state.resolved.exists||state.requested.sha256!==state.resolved.sha256||state.requested.bytes!==state.resolved.bytes)fail("Actual KnownFolder aliases disagree");
  return state;
}
function snapshotAliases(plan,label) {
  const state=validateSettingsAliases(knownFolderState(identity)),backups={};
  for(const name of ["requested","resolved"]){const item=state[name];if(item.exists){const path=join(plan.work,"settings-preserved",label+"-"+name+".json");copyFileSync(item.path,path,constants.COPYFILE_EXCL);backups[name]=verifyRecord({...item,path},"Original KnownFolder alias bytes");}}
  const snapshot={state,backups};writeNew(join(plan.work,"settings-preserved",label+"-aliases.json"),snapshot);return snapshot;
}
function clearAliases(plan,snapshot,boundary,onBeforeMutation=()=>{}) {
  requireReleasedSettingsBoundary(boundary);validateSettingsAliases(snapshot.state);
  knownUnchanged(snapshot.state,knownFolderState(identity));
  onBeforeMutation();
  for(const item of [snapshot.state.requested,snapshot.state.resolved])if(existsSync(item.path))unlinkSync(item.path);
  const after=validateSettingsAliases(knownFolderState(identity));if(after.requested.exists||after.resolved.exists||norm(after.requested.path)!==norm(snapshot.state.requested.path))fail("Actual isolated settings aliases were not cleared");
  return after;
}
function restoreAliases(plan,initial,boundary) {
  requireReleasedSettingsBoundary(boundary);const current=snapshotAliases(plan,"final-current");clearAliases(plan,current,boundary);
  if(initial.state.requested.exists){const bytes=readFileSync(verifyRecord(initial.backups.requested,"Initial settings backup").path);mkdirSync(dirname(initial.state.requested.path),{recursive:true});writeFileSync(initial.state.requested.path,bytes,{flag:"wx"});}
  const after=validateSettingsAliases(knownFolderState(identity));
  if(initial.state.requested.exists)knownUnchanged(initial.state,after);
  else if(after.requested.exists||after.resolved.exists||norm(initial.state.requested.path)!==norm(after.requested.path))fail("Initially absent isolated settings were not restored to absence");
  return {initial:initial.state,current,after,canonicalMappingMayChangeWhileAbsent:!initial.state.requested.exists};
}
// The installed app creates %APPDATA%\<identifier> and %LOCALAPPDATA%\<identifier> through the KnownFolder
// API (env overrides do not apply). Observe both; at the end remove each only if it was absent before and is empty.
function localDataState(plan){const paths=powershell(plan,localDataScript,{KINSHOKO_T20_IDENTIFIER:identity});return Object.fromEntries(["local","roaming"].map(name=>{const path=paths[name];if(!isAbsolute(path??"")||basename(path)!==identity)fail("Unexpected isolated "+name+" data path");const exists=existsSync(path);return [name,{path,exists,entries:exists?readdirSync(path):[]}];}));}
// Runs after the settings file itself is restored, so an initially absent Roaming directory is empty again.
function restoreLocalData(plan,initial){const current=localDataState(plan),removed=[];
  for(const name of ["local","roaming"]){const before=initial[name],now=current[name];if(norm(before.path)!==norm(now.path))fail("Isolated "+name+" data path changed");
    if(before.exists){if(!now.exists)fail("Pre-existing isolated "+name+" data disappeared");continue;}
    if(now.exists){if(now.entries.length||!statSync(now.path).isDirectory())fail("Isolated "+name+" data created during the run is not empty; preserve it");rmdirSync(now.path);removed.push(name);}}
  const after=localDataState(plan);for(const name of ["local","roaming"])if(after[name].exists!==initial[name].exists)fail("Isolated "+name+" data directory was not restored");return {initial,current,after,removed};}
export class InstalledLifecycleDriver extends CombinationDriver {
  constructor(plan,stage,phase){super({application:stage.application,edgeDriver:plan.runtime.edgeDriver.path,tauriDriver:plan.runtime.tauriDriver.path,work:stage.work,port:4630,data:stage.data,profile:stage.profile});this.plan=plan;this.phase=phase;this.binding={application:this.application,tauriDriver:this.tauriDriver,edgeDriver:this.edgeDriver,webviewBinary:plan.runtime.webviewBinary.path,profile:this.profile,spawned:[]};this.logs=[];}
  querySnapshot(){return powershell(this.plan,installationObservationScript);}
  observeOwned(){return classifyInstallationProcesses(this.querySnapshot(),this.binding,this.ownedProcesses);}
  captureSpawnedDriver(){const snapshot=this.querySnapshot(),observedAt=Date.now(),observed=snapshot.processes.find(value=>value.pid===this.process.pid);if(!observed)return null;const item={...observed,birth:{startedAt:this.spawnStartedAt,returnedAt:this.spawnReturnedAt,observedAt,childPid:this.process.pid,creatorPid:process.pid,executable:this.tauriDriver}};this.record("actual-driver-birth-observation",item);if(!boundedBirth(item)||norm(item.executable)!==norm(this.tauriDriver)||this.process.exitCode!==null||this.process.signalCode!==null)fail("Initial installed-app driver birth is not this round's live exact spawn");this.binding.spawned=[item];this.rememberOwned(classifyInstallationProcesses(snapshot,this.binding,this.ownedProcesses));return item;}
  async boot(){const before=this.observeOwned();this.assert(!before.processes.length&&!before.ports.length&&!before.collisions.length,"installed lifecycle starts with its exact native scope unused",before);
    for(const path of [this.data,this.profile,join(this.work,"roaming"),join(this.work,"local")])mkdirSync(path,{recursive:true});
    const out=openSync(join(this.work,this.phase+"-driver-stdout.txt"),"wx"),err=openSync(join(this.work,this.phase+"-driver-stderr.txt"),"wx");this.logs.push(out,err);this.spawnStartedAt=Date.now();
    this.process=spawn(this.tauriDriver,["--port","4630","--native-port","4631","--native-driver",this.edgeDriver],{windowsHide:true,stdio:["ignore",out,err],env:{...process.env,APPDATA:join(this.work,"roaming"),LOCALAPPDATA:join(this.work,"local"),KINSHOKO_DATA_DIR:this.data,WEBVIEW2_USER_DATA_FOLDER:this.profile,KINSHOKO_SKIP_AUTOSTART:"1"}});this.spawnReturnedAt=Date.now();this.process.on("error",error=>this.record("spawn-error",{error:String(error)}));
    this.spawnedDriver=await until("exact installed lifecycle driver birth",()=>this.captureSpawnedDriver());this.record("initial-installed-driver",this.spawnedDriver);
    await until("owned installed driver ready",()=>fetch(this.url+"/status").then(value=>value.ok));
    const value=await this.request("POST","/session",{capabilities:{alwaysMatch:{"tauri:options":{application:this.application,webviewOptions:{userDataFolder:this.profile}}}}});if(!value?.sessionId)fail("Actual installed WebDriver session has no ID");this.session="/session/"+value.sessionId;
    await this.request("POST",this.session+"/timeouts",{script:180000,implicit:0,pageLoad:60000});await this.main();this.rememberOwned(this.observeOwned());this.record("actual-installed-capabilities",value.capabilities);
  }
  async main(){return until("actual main window IPC including old onboarding",async()=>{for(const handle of await this.request("GET",this.session+"/window/handles")){await this.request("POST",this.session+"/window",{handle});if(await this.exec("return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label==='main'&&!!window.__TAURI_INTERNALS__?.invoke;"))return handle;}return null;});}
  save(name,value){return super.save(this.phase+"-"+name,value);}
  screenshot(name){return super.screenshot(this.phase+"-"+name);}
  terminateOwned(expected,label){if(expected.some(item=>!exact(item)))fail("Installed cleanup requires exact verified identities");const result=spawnSync(this.plan.runtime.powershell.path,["-NoProfile","-NonInteractive","-Command",browserTerminationScript],{windowsHide:true,encoding:"utf8",env:{...process.env,KINSHOKO_T20_BROWSER_TERMINATE:JSON.stringify([...expected].reverse())}});this.record(label,{exit:result.status,error:result.error?String(result.error):null,stdout:result.stdout,stderr:result.stderr});if(result.status!==0||result.error)fail("Installed exact lineage cleanup failed: "+result.stderr);return {exit:result.status};}
  async waitReleased(label){const first=this.observeOwned();if(first.collisions.length)fail("Foreign native collision remains; never adopt or close it");return untilStrict(label,()=>{const state=this.observeOwned();this.rememberOwned(state);if(state.collisions.length)fail("Foreign native collision appeared during release");return !state.processes.length&&!state.ports.length?state:null;},15000);}
  async normalQuit(){const path=join(this.work,this.phase+"-normal-tray-quit.json"),helper=this.plan.helpers.tray.path;verifyRecord(this.plan.helpers.tray,"Guarded T19 normal tray helper");
    const result=spawnSync(this.plan.runtime.python.path,[helper,this.application,path],{windowsHide:true,encoding:"utf8",timeout:45000});this.record("actual-tray-helper-command",{executable:this.plan.runtime.python.path,args:[helper,this.application,path],exit:result.status,error:result.error?String(result.error):null,stdout:result.stdout,stderr:result.stderr});
    if(result.status!==0||result.error)fail("Actual guarded normal tray Quit failed");const receipt=readJson(path);this.assert(receipt.method==="automated-native-menu-dispatch"&&receipt.processEnded===true&&receipt.exitCode===0,"installed program exits normally through the actual guarded tray Quit",receipt);
    if(this.session)await this.request("DELETE",this.session).catch(error=>this.record("ended-session-delete",{error:String(error)}));this.session=null;await this.stopDriver();const after=await this.waitReleased("normal Quit releases exact installed app/profile/drivers/ports");this.release={released:true,normalQuit:receipt,after};this.save("release.json",this.release);this.save("command-trace.json",this.trace);this.closeLogs();return this.release;
  }
  closeLogs(){for(const fd of this.logs)closeSync(fd);this.logs=[];}
  async cleanup(){try{return await super.cleanup();}finally{this.closeLogs();}}
}
function settings(view){const value={autostart:view.autostart,showApproxSource:view.showApproxSource,forceSrgb:view.forceSrgb,usageLog:view.usageLog,shortcuts:view.shortcuts.map(item=>({action:item.action,accelerator:item.accelerator})).sort((a,b)=>a.action.localeCompare(b.action))};if(Object.hasOwn(view,"viewerBackground"))value.viewerBackground=view.viewerBackground;return value;}
function uiAdapter(d){return Object.assign(Object.create(CombinationWorkflow.prototype),{d,state:{phase:"installer-lifecycle-single-library"},receipts:[]});}
function patternPng(){
  function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,body,checksum]);}
  const width=512,height=320,header=Buffer.alloc(13),raw=Buffer.alloc(height*(1+width*3));header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*(1+width*3)+1+x*3;raw[p]=x%256;raw[p+1]=y%256;raw[p+2]=(x+y)%256;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
export function prepareInstallationLifecycle({releaseReceipt,work,edgeDriver,tauriDriver,webviewBinary,python,powershell:ps}) {
  trackedSelf();const root=ownedWork(work);if(existsSync(root))fail("Use a fresh lifecycle root; preserve all previous install rounds");
  const build=checkReleaseInstallerBuild(releaseReceipt);if(build.receipt.version!=="0.1.2")fail("This lifecycle requires the actual isolated 0.1.2 release package");
  const source=sourceRecord();sameSnapshot(build.receipt.before.source,source,"Actual lifecycle release source");
  const stages=Object.fromEntries(["clean","upgrade"].map(name=>{const stage=join(root,name,"t19-upgrade"),installDir=join(stage,"installed");return [name,{work:stage,installDir,application:join(installDir,INSTALLER_IDENTITY.mainBinaryName+".exe"),data:join(stage,"app-data"),profile:join(stage,"fresh-webview"),libraries:join(stage,"libraries"),source:join(stage,"source")}];}));
  const plan={kind:"spec78-t20-actual-installation-lifecycle-plan",status:"prepared-not-run",repository:repo,at:new Date().toISOString(),source,work:root,release:build.record,old:build.old,new:{version:build.receipt.version,installer:build.installer,actualPackaged:build.actualPackaged,runtime:build.runtime},identity:INSTALLER_IDENTITY,stages,runtime:{edgeDriver:fileRecord(edgeDriver),tauriDriver:fileRecord(tauriDriver),webviewBinary:fileRecord(webviewBinary),python:fileRecord(python),powershell:fileRecord(ps)},helpers:{lifecycle:fileRecord(self),tray:fileRecord(join(repo,"e2e","native-tray-exit.py")),locks:fileRecord(join(repo,"e2e","nsis-file-locks.py")),driver:fileRecord(join(repo,"e2e","spec78-combination-driver.mjs")),workflow:fileRecord(join(repo,"e2e","spec78-combination-workflow.mjs")),ownership:fileRecord(join(repo,"e2e","spec78-combination-prototype-browser.mjs"))},windows:windowsRelease(),nativeExecuted:false,installerExecuted:false,fullT20Acceptance:false};
  validateInstallationPlan(plan);mkdirSync(root);writeNew(join(root,"installation-lifecycle-plan.json"),plan);return plan;
}
export function validateInstallationPlan(plan) {
  if(plan.kind!=="spec78-t20-actual-installation-lifecycle-plan"||plan.status!=="prepared-not-run"||plan.repository!==repo||!eq(plan.identity,INSTALLER_IDENTITY)||plan.new.version!=="0.1.2"||plan.nativeExecuted!==false||plan.installerExecuted!==false||plan.fullT20Acceptance!==false)fail("Expected the exact unused isolated 0.1.0 -> 0.1.2 release lifecycle plan");
  const root=ownedWork(plan.work);
  for(const name of ["clean","upgrade"]){const stage=plan.stages?.[name],work=join(root,name,"t19-upgrade"),installDir=join(work,"installed");if(!stage||stage.work!==work||stage.installDir!==installDir||stage.application!==join(installDir,"kinshoko-t19-upgrade.exe")||stage.data!==join(work,"app-data")||stage.profile!==join(work,"fresh-webview")||stage.libraries!==join(work,"libraries")||stage.source!==join(work,"source"))fail("The lifecycle target/data/profile differs from its fresh owned stage");}
  if(plan.stages.clean.application===plan.stages.upgrade.application||plan.stages.clean.data===plan.stages.upgrade.data||plan.stages.clean.profile===plan.stages.upgrade.profile)fail("The clean and upgrade stages must be independent");
  return plan;
}
// Exported for offline public boundary checks; launch/query are the only OS seams.
export class InstallationRound {
  constructor(plan,report,save){this.plan=plan;this.report=report;this.save=save;this.drivers=new Map();this.installerSettled=true;}
  launch(executable,args,options){return spawn(executable,args,options);}
  query(){return powershell(this.plan,installationObservationScript);}
  registry(label){const state=powershell(this.plan,registryObservationScript);if(!Array.isArray(state.run)||state.run.length!==4||!Array.isArray(state.uninstall))fail("Registry observation is incomplete");writeNew(join(this.plan.work,label+"-registry.json"),state);if(this.report.initialRegistry&&!eq(this.report.initialRegistry.run,state.run))fail("Formal or isolated Run value/type changed; do not overwrite from a stale snapshot");return state;}
  scopes(){const snapshot=this.query();return ["clean","upgrade"].map(name=>{const stage=this.plan.stages[name],d=this.drivers.get(name),binding=d?.binding??{application:stage.application,tauriDriver:this.plan.runtime.tauriDriver.path,edgeDriver:this.plan.runtime.edgeDriver.path,webviewBinary:this.plan.runtime.webviewBinary.path,profile:stage.profile,spawned:[]};return classifyInstallationProcesses(snapshot,binding,d?.ownedProcesses??[]);});}
  released(){const value={installerSettled:this.installerSettled,scopes:this.scopes()};requireReleasedSettingsBoundary(value);return value;}
  installedRegistry(state,stage,version){if(!state.uninstall.length)fail("The actual isolated install has no authoritative uninstall registration");for(const entry of state.uninstall){const uninstall=commandTokens(entry.UninstallString??"")[0];if(entry.DisplayName!==INSTALLER_IDENTITY.productName||entry.DisplayVersion!==version||norm(uninstall)!==norm(join(stage.installDir,"uninstall.exe"))||entry.InstallLocation&&norm(registryPathValue(entry.InstallLocation))!==norm(stage.installDir))fail("An isolated uninstall entry does not belong to this exact installed target/version");}if(!state.product?.exists||state.product.subkeys.length||!state.product.values.some(item=>item.name===""&&norm(item.value)===norm(stage.installDir)))fail("The isolated NSIS product key does not record this exact installed target");return state.uninstall;}
  payload(stage,kind){const actual=fileRecord(stage.application),version=powershell(this.plan,installedVersionScript,{KINSHOKO_T20_INSTALLED_EXE:stage.application}),expectedVersion=kind==="old"?"0.1.0":"0.1.2",expectedSha=kind==="old"?this.plan.old.packagedExeSha256:this.plan.new.actualPackaged.sha256;
    if(actual.sha256!==expectedSha||version.ProductVersion!==expectedVersion)fail("Actual installed EXE hash or PE version differs from its NSIS payload");
    const runtime={};if(kind==="old"){const dll=fileRecord(join(stage.installDir,"DirectML.dll"));if(dll.sha256!==this.plan.old.directmlSha256)fail("Installed actual old DirectML differs");runtime["DirectML.dll"]=dll;}else for(const [name,expected] of Object.entries(this.plan.new.runtime))runtime[name]=verifyRecord({...expected,path:join(stage.installDir,name)},"Actual installed release runtime "+name);
    const uninstaller=fileRecord(join(stage.installDir,"uninstall.exe"));return {actual,version,runtime,uninstaller,source:kind==="old"?this.plan.old.source:this.plan.source.source,profile:kind==="old"?"debug":"release"};
  }
  async installer(label,executable,args,stage){
    this.released();verifyRecord(executable,"Exact granted NSIS executable");verifyRecord(this.plan.helpers.locks,"Readonly guarded RestartManager helper");
    const before=this.query();if(before.processes.some(item=>norm(item.executable)===norm(executable.path)))fail("A pre-existing exact NSIS executable is a collision, not this round's process");
    const locks=spawnSync(this.plan.runtime.python.path,[this.plan.helpers.locks.path,stage.application],{windowsHide:true,encoding:"utf8",timeout:10000});if(locks.status!==0||locks.error)fail("Actual RestartManager observation failed: "+locks.stderr);const users=JSON.parse(locks.stdout);if(!Array.isArray(users.users)||users.users.length)fail("Actual install target still has RestartManager users");
    const action={label,executable,args,cwd:repo,locks:users,startedAt:new Date().toISOString(),status:"starting",birth:null,observed:[],release:null,exit:null};this.report.actions.push(action);this.installerSettled=false;this.save();
    const out=openSync(join(this.plan.work,label+"-stdout.txt"),"wx"),err=openSync(join(this.plan.work,label+"-stderr.txt"),"wx");let child,spawnError,exitedAt=null;
    try{const startedAt=Date.now();child=this.launch(executable.path,args,{cwd:repo,windowsHide:true,stdio:["ignore",out,err]});const returnedAt=Date.now();child.on("error",error=>{spawnError=error;});child.on("exit",()=>{exitedAt??=Date.now();});action.spawnTiming={startedAt,returnedAt,childPid:child.pid};this.save();
      action.birth=await untilStrict("actual NSIS ChildProcess birth "+label,()=>{if(spawnError)fail(String(spawnError));const snapshot=this.query(),observedAt=Date.now(),observed=snapshot.processes.find(value=>value.pid===child.pid);if(!observed){if(exitedAt===null)return null;action.exitedBeforeObservation=exitedBeforeObservation(snapshot,{pid:child.pid,startedAt,returnedAt,exitedAt,exit:child.exitCode,signal:child.signalCode});return action.exitedBeforeObservation;}const item={...observed,birth:{startedAt,returnedAt,observedAt,childPid:child.pid,creatorPid:process.pid,executable:executable.path}};if(!boundedBirth(item)||norm(item.executable)!==norm(executable.path)||child.exitCode!==null||child.signalCode!==null)fail("NSIS process birth is not this round's exact live spawn");return item;});this.report.installerExecuted=true;action.status="running";this.save();
      const historical=[];if(action.exitedBeforeObservation){action.exit=child.exitCode;action.signal=child.signalCode;}action.release=action.exitedBeforeObservation?{checkedAt:action.exitedBeforeObservation.checkedAt,processes:[],exitedBeforeObservation:true}:await untilStrict("actual NSIS exit and verified descendant release "+label,()=>{if(spawnError)fail(String(spawnError));const snapshot=this.query(),current=selectSpawnLineage(snapshot,[action.birth],historical);for(const item of current)if(!historical.some(prior=>sameInstance(item,prior)))historical.push(item);action.observed=historical;action.exit=child.exitCode;action.signal=child.signalCode;this.save();return child.exitCode!==null&&!current.length?{checkedAt:snapshot.checkedAt,processes:current}:null;},120000);
      this.installerSettled=true;action.finishedAt=new Date().toISOString();action.status=action.exit===0&&!action.signal?"exited-and-released":"failed-exit-released";this.save();if(action.exit!==0||action.signal)fail("Actual NSIS command exited with failure; do not retry this sample");return action;
    }catch(error){action.error=String(error);if(!action.release){action.status="failed-unconfirmed";action.exit=child?.exitCode;action.signal=child?.signalCode;}this.save();throw error;}finally{closeSync(out);closeSync(err);}
  }
  async install(label,kind,stage,update=false){
    if(!update&&existsSync(stage.installDir))fail("Clean/old NSIS installation requires an unused target");
    const executable=kind==="old"?this.plan.old.installer:this.plan.new.installer,args=["/S",...(update?["/UPDATE"]:[]),"/D="+stage.installDir];await this.installer(label,executable,args,stage);
    const payload=this.payload(stage,kind),registry=this.registry(label+"-after");this.installedRegistry(registry,stage,kind==="old"?"0.1.0":"0.1.2");this.report.observations.push({label,payload,registry});this.save();return payload;
  }
  async uninstall(label,stage,payload){const before=this.registry(label+"-before");this.installedRegistry(before,stage,payload.version.ProductVersion);verifyRecord(payload.uninstaller,"This target's actual uninstaller");await this.installer(label,payload.uninstaller,["/S","_?="+stage.installDir],stage);const after=this.registry(label+"-after");if(existsSync(stage.application)||after.uninstall.length)fail("Actual isolated target/uninstall registration remains after uninstall");this.released();
    const productKeyRemoval=after.product?.exists?powershell(this.plan,productKeyRemovalScript,{KINSHOKO_T20_STAGE_INSTALL_DIR:stage.installDir}):{removed:false,absent:true};const cleaned=this.registry(label+"-product-key-removed");if(cleaned.product?.exists)fail("The isolated NSIS product key remains after removal");
    this.report.observations.push({label,applicationAbsent:true,registry:after,productKeyResidue:after.product,productKeyRemoval,registryAfterRemoval:cleaned});this.save();}
  async native(name,phase,task){const d=new InstalledLifecycleDriver(this.plan,this.plan.stages[name],phase);this.drivers.set(name,d);this.report.nativeAttempted=true;this.save();let failure;
    try{await d.boot();this.report.nativeExecuted=true;this.registry(phase+"-started");const value=await task(d);const normalQuit=await d.normalQuit();this.registry(phase+"-normal-quit");this.report.observations.push({phase,normalQuit,value});this.save();return value;
    }catch(error){failure=error;if(d.session){await d.screenshot("failure.png").catch(value=>d.record("failure-screenshot-error",{error:String(value)}));}throw error;
    }finally{if(!d.release?.released){try{await d.cleanup();}catch(error){this.report.cleanupFailures.push({phase,error:String(error),release:d.release});if(!failure)throw error;}finally{this.save();}}else d.closeLogs();}
  }
}
async function publicState(d,reference){
  await d.main();const library=await d.invoke("current_library"),registrations=await d.invoke("registered_libraries"),shell=settings(await d.invoke("shell_settings",{},null)),group=(await d.invoke("reference_group",{groupId:reference.groupId},"desktop")).group,safeMode=await d.invoke("safe_mode");
  await d.window("pin-"+reference.pinId);const frame=await until("actual restored pin frame",()=>d.invoke("pin_frame",{pin:reference.pinId},"desktop"));await d.main();
  if(safeMode!==true||frame.veiled||frame.unavailable)fail("Actual saved source/pin is unavailable or global safe mode changed");
  return {library,registrations,settings:shell,group,pin:frame.pin,safeMode};
}
async function createSavedState(d,stage,legacy){
  d.assert((await d.invoke("registered_libraries")).length===0&&await d.invoke("current_library")===null,"actual fresh installed program starts with no library registration");d.assert(await d.invoke("safe_mode")===true,"fresh installed program keeps safe mode enabled");
  for(const path of [stage.libraries,stage.source])mkdirSync(path,{recursive:true});const original=join(stage.source,"upgrade-pattern.png");writeFileSync(original,patternPng(),{flag:"wx"});
  await d.type("//label[contains(.,'资料库名称')]/input",legacy?"本轮实际旧版升级资料库":"本轮实际干净安装资料库");await d.pick(stage.libraries);await d.enabled("//button[normalize-space()='选择存放位置…']");await d.click("//button[normalize-space()='选择存放位置…']");await d.enabled("//button[normalize-space()='建立资料库']");await d.click("//button[normalize-space()='建立资料库']");const library=await until("actual installed onboarding creates library",()=>d.invoke("current_library"));let target,importReceipt;
  if(legacy){await d.pick(stage.source);await d.enabled("//button[normalize-space()='导入文件夹…']");await d.click("//button[normalize-space()='导入文件夹…']");const page=await until("actual old installed import",async()=>{const value=await d.invoke("browse",{libraryId:library.id,query:{scope:{kind:"all"},conditions:{conditions:[]},cursor:null,limit:100,thumbnailPx:128}});return value.total===1?value:null;},60000);target={libraryId:library.id,imageId:page.cards[0].id,contentId:sha256(readFileSync(original))};importReceipt=page;
  }else{const ui=uiAdapter(d);importReceipt=await ui.import([original],library.id);const page=await ui.local(library.id),card=page.cards.find(value=>value.id===sha256(readFileSync(original))),source=card?.sources.find(value=>value.libraryId===library.id);if(!source||page.total!==1)fail("Actual clean public import did not expose its exact original/source identity");target={libraryId:library.id,imageId:source.imageId,contentId:card.id};}
  // Do not call set_autostart: the exact Run entries are read-only throughout this run.
  await d.invoke("set_show_approx_source",{on:true},null);await d.invoke("set_usage_log",{on:true},null);for(const action of ["capture","pinClipboard","hideAllPins"])await d.invoke("rebind_shortcut",{action,accelerator:null},null);
  await d.invoke("pin_reference",{libraryId:library.id,imageId:target.imageId,crop:{x:32,y:24,width:200,height:160},shown:{x:240,y:180,width:200,height:160}},"desktop");const label=await until("actual installed pin window",async()=>(await d.invoke("get_all_windows",{},"window")).find(value=>value.startsWith("pin-"))),pinId=label.slice(4);await d.window(label);
  await until("actual installed pin canvas",()=>d.exec("const node=document.querySelector('.pin-canvas');return !!node&&node.width>0&&node.height>0;"));
  await d.invoke("zoom_pin",{pin:pinId,scale:0.75,anchorX:240,anchorY:180},"desktop");for(const turn of ["flipHorizontal","rotateClockwise"])await d.invoke("turn_pin",{pin:pinId,turn},"desktop");await d.invoke("move_pin",{pin:pinId,x:160,y:120},"desktop");await d.invoke("set_pin_opacity",{pin:pinId,opacity:0.6},"desktop");await d.invoke("set_pin_locked",{pin:pinId,locked:true},"desktop");await d.main();
  const group=await d.invoke("save_reference_group",{name:legacy?"本轮真实旧版保存参考组":"本轮真实干净安装保存参考组",captures:[]},"desktop"),reference={target,groupId:group.id,pinId,original:fileRecord(original),width:512,height:320};const state=await publicState(d,reference);await d.screenshot("saved-state.png");d.save("actual-saved-state.json",{reference,state,importReceipt});return {reference,state,importReceipt};
}
async function restoredState(d,before){const after=await publicState(d,before.reference);assertPreservedFields(before.state,after,"actual prior user state");const inspection=await d.invoke("workspace_source_inspection",{target:before.reference.target,safeMode:true,lang:"zh-CN"});d.assert(inspection.detail.id===before.reference.target.imageId&&inspection.detail.width===before.reference.width&&inspection.detail.height===before.reference.height,"new installed app resolves the actual preserved original source",inspection.detail);verifyRecord(before.reference.original,"Original retained through installed lifecycle");return {after,inspection};}
async function currentRuntimeAndUpdate(d){const adapter=uiAdapter(d);await adapter.runtimeAndUpdateUI();const checked=await d.invoke("check_update",{},null);d.assert(checked.state==="manual"&&checked.message==="当前使用安装包手动更新。","actual installed manual check retains current guidance",checked);let refused;try{await d.invoke("install_update",{},null);}catch(error){refused=String(error);}d.assert(refused?.includes("手动更新"),"actual installed release refuses automatic install at the public boundary",refused);return adapter.state.runtimeAndUpdate;}
export async function runInstallationLifecycle(planPath,rootGrant){
  trackedSelf();if(!rootGrant?.trim())fail("A new exclusive root installation/native grant for this exact plan is required");const plan=validateInstallationPlan(readJson(planPath));verifyRecord(plan.release,"Actual release receipt");const build=checkReleaseInstallerBuild(plan.release.path);if(!eq(build.old,plan.old)||!eq(build.installer,plan.new.installer)||!eq(build.actualPackaged,plan.new.actualPackaged)||!eq(build.runtime,plan.new.runtime))fail("Lifecycle package inputs differ from the exact attributed build");sameSnapshot(plan.source,sourceRecord(),"Final installed lifecycle source");
  for(const [name,record] of Object.entries({...plan.runtime,...plan.helpers}))verifyRecord(record,"Frozen installation runtime/helper "+name);
  for(const stage of Object.values(plan.stages))if(existsSync(stage.work))fail("Preserve an existing lifecycle stage; this plan must be unused");
  const path=join(plan.work,"installation-lifecycle-result.json");if(existsSync(path))fail("Preserve the prior lifecycle result");mkdirSync(join(plan.work,"settings-preserved"));
  const report={kind:"spec78-t20-actual-installed-clean-and-upgrade",status:"running",startedAt:new Date().toISOString(),plan:fileRecord(planPath),rootGrant,source:plan.source,windows:windowsRelease(),old:plan.old,new:plan.new,actions:[],observations:[],cleanupFailures:[],initialRegistry:null,initialT19:null,initialT20:null,restoration:null,nativeAttempted:false,nativeExecuted:false,installerExecuted:false,windows10:"unverified-owner-accepted-no-device",developerAcceptance:"unverified",colorGate:"independent-existing-results-unchanged",fullT20Acceptance:false};const save=()=>writeFileSync(path,JSON.stringify(report,null,2));save();const round=new InstallationRound(plan,report,save);let failure;
  try{
    report.initialRegistry=round.registry("initial");if(report.initialRegistry.uninstall.length||report.initialRegistry.product?.exists!==false||report.initialRegistry.run.some(value=>value.name===INSTALLER_IDENTITY.productName&&value.exists))fail("A pre-existing isolated installation/Run entry must be preserved; do not adopt it");report.initialT20=knownFolderState();report.initialLocalData=localDataState(plan);report.initialT19=snapshotAliases(plan,"initial");round.released();report.blankBefore=clearAliases(plan,report.initialT19,round.released(),()=>{report.settingsTouched=true;save();});save();
    for(const stage of Object.values(plan.stages))mkdirSync(stage.work,{recursive:true});
    const cleanPayload=await round.install("clean-release-install","new",plan.stages.clean);let cleanBefore;
    cleanBefore=await round.native("clean","clean-create-save",async d=>{const saved=await createSavedState(d,plan.stages.clean,false);const runtimeAndUpdate=await currentRuntimeAndUpdate(d);return {...saved,runtimeAndUpdate};});
    report.cleanRestart=await round.native("clean","clean-real-restart",async d=>restoredState(d,cleanBefore));await round.uninstall("clean-release-uninstall",plan.stages.clean,cleanPayload);
    const afterClean=snapshotAliases(plan,"after-clean");report.blankBeforeUpgrade=clearAliases(plan,afterClean,round.released());save();
    const oldPayload=await round.install("actual-old-0.1.0-install","old",plan.stages.upgrade);report.actualOldPayload=oldPayload;
    const oldBefore=await round.native("upgrade","actual-old-create-save",d=>createSavedState(d,plan.stages.upgrade,true));report.actualOldSaved=oldBefore;save();
    // No uninstall between actual old save/normal Quit and this real UPDATE command.
    const updatedPayload=await round.install("actual-new-0.1.2-release-update","new",plan.stages.upgrade,true);
    report.actualUpdatedState=await round.native("upgrade","actual-new-after-update",async d=>{const restored=await restoredState(d,oldBefore),runtimeAndUpdate=await currentRuntimeAndUpdate(d);return {...restored,runtimeAndUpdate};});await round.uninstall("actual-updated-release-uninstall",plan.stages.upgrade,updatedPayload);
    report.status="actual-clean-and-old-to-new-lifecycles-observed";save();
  }catch(error){failure=error;report.status="failed";report.error=String(error);process.exitCode=1;
  }finally{
    try{const boundary=round.released();report.finalRelease=boundary;round.registry("final-before-settings-restore");if(report.initialT19&&report.settingsTouched)report.restoration=restoreAliases(plan,report.initialT19,boundary);else if(report.initialT19)knownUnchanged(report.initialT19.state,knownFolderState(identity));if(report.initialLocalData)report.localDataRestoration=restoreLocalData(plan,report.initialLocalData);if(report.initialT20){report.finalT20=knownFolderState();knownUnchanged(report.initialT20,report.finalT20);}report.finalRegistry=round.registry("final-after-settings-restore");if(report.finalRegistry.uninstall.length||report.finalRegistry.product?.exists)fail("An isolated installation record remains after the lifecycle");}catch(error){report.restorationError=String(error);report.status="failed-release-or-restoration";process.exitCode=1;if(!failure)failure=error;}
    try{report.sourceAfter=sourceRecord();sameSnapshot(plan.source,report.sourceAfter,"Source throughout actual installation lifecycle");}catch(error){report.sourceError=String(error);report.status="failed-source-attribution";process.exitCode=1;if(!failure)failure=error;}
    report.finishedAt=new Date().toISOString();save();
  }
  if(failure)throw failure;return report;
}
export async function main(args=process.argv.slice(2)){
  if(args[0]==="--prepare"&&args.length===2)return prepareInstallationLifecycle(readJson(args[1]));
  if(args[0]==="--run"&&args.length===3)return runInstallationLifecycle(args[1],args[2]);
  fail("node e2e/spec78-combination-installation-lifecycle.mjs --prepare <inputs.json> | --run <exact-plan.json> <new-root-exclusive-grant>");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await main()));}catch(error){console.error(error);process.exitCode=1;}}
