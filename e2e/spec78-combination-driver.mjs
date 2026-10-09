// T20 WebDriver adapter. Importing this module never starts a process.
// Adapted from the existing formal native harnesses; all product actions stay public IPC/UI.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
const ELEMENT="element-6066-11e4-a52e-4f735466cecf";
const sleep=(ms)=>new Promise(done=>setTimeout(done,ms));
export async function until(label,read,timeout=30000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end) {try {const value=await read();if(value)return value;} catch(error){last=error;} await sleep(100);}
  throw Error(`Timed out: ${label}${last?` (${last.message})`:""}`);
}
export class CombinationDriver {
  constructor({application,edgeDriver,tauriDriver,work,port,data,profile}) {
    this.application=resolve(application);this.edgeDriver=resolve(edgeDriver);this.tauriDriver=resolve(tauriDriver);
    this.work=resolve(work);this.port=port;this.data=resolve(data);this.profile=resolve(profile);
    if(!this.work.startsWith(resolve("work/e2e")+sep)||!this.work.includes("spec78-t20"))throw Error("Native run directory must be owned by T20");
    if(![this.data,this.profile].every(path=>path.startsWith(this.work+sep)))throw Error("Data/profile must remain inside the native run directory");
    if(port!==4630)throw Error("T20 combination reserves ports4630/4631 only");
    this.url=`http://127.0.0.1:${port}`;this.process=null;this.session=null;this.trace=[];this.assertions=[];this.ownedProcesses=[];this.release=null;
  }
  async request(method,path,body) {
    const response=await fetch(this.url+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok)throw Error(`${method} ${path}: HTTP ${response.status}: ${JSON.stringify(result.value)}`);
    if(result.value&&typeof result.value==="object"&&"error" in result.value)this.record("webdriver-business-error-value",{method,path,httpStatus:response.status,value:result.value});
    return result.value;
  }
  async boot() {
    const state=this.observeOwned();this.record("owned-native-start-preflight",state);
    if(state.ports.length||state.processes.length)throw Error("The exact T20 application/profile/drivers or reserved ports are still occupied");
    this.release=null;
    for(const path of [this.data,this.profile,join(this.work,"roaming"),join(this.work,"local")])mkdirSync(path,{recursive:true});
    this.process=spawn(this.tauriDriver,["--port",String(this.port),"--native-port",String(this.port+1),"--native-driver",this.edgeDriver],{
      windowsHide:true,stdio:["ignore","inherit","inherit"],env:{...process.env,APPDATA:join(this.work,"roaming"),LOCALAPPDATA:join(this.work,"local"),KINSHOKO_DATA_DIR:this.data,WEBVIEW2_USER_DATA_FOLDER:this.profile,KINSHOKO_SKIP_AUTOSTART:"1"},
    });
    await until("owned driver status",()=>fetch(this.url+"/status").then(r=>r.ok));
    const started=await this.request("POST","/session",{capabilities:{alwaysMatch:{"tauri:options":{application:this.application,webviewOptions:{userDataFolder:this.profile}}}}});
    this.session=`/session/${started.sessionId}`;
    await this.request("POST",this.session+"/timeouts",{script:180000,implicit:0,pageLoad:60000});
    await this.main();
    this.rememberOwned(this.observeOwned());
    this.record("session-start",{sessionId:started.sessionId,application:this.application,profile:this.profile,data:this.data,driverPid:this.process.pid});
  }
  async main() {
    return until("formal main window and controls",async()=>{
      for(const handle of await this.request("GET",this.session+"/window/handles")) {
        await this.request("POST",this.session+"/window",{handle});
        if(await this.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke)&&Boolean(document.querySelector('button[aria-label=设置]'));"))return handle;
      }
      return false;
    });
  }
  exec(script,args=[]) {return this.request("POST",this.session+"/execute/sync",{script,args});}
  async async(script,args=[]) {return this.request("POST",this.session+"/execute/async",{script,args});}
  async invoke(command,args={},plugin="library") {
    const full=plugin===null?command:`plugin:${plugin}|${command}`;
    this.record("command-start",{command:full,args});
    const result=await this.async("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({failure:String(error)}));",[full,args]);
    this.record("command-settled",{command:full,result});
    if(result.failure)throw Error(`${full}: ${result.failure}`);return result.value;
  }
  record(kind,value) {this.trace.push({index:this.trace.length,at:new Date().toISOString(),kind,value});}
  assert(ok,label,value) {this.record("assert",{label,ok,value});if(!ok)throw Error(label);this.assertions.push(label);console.log(`PASS ${label}`);}
  async events(names) {
    await this.async("const done=arguments[arguments.length-1];window.__T20_EVENTS__=[];Promise.all(arguments[0].map(event=>window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event,target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(payload=>window.__T20_EVENTS__.push({at:Date.now(),payload}))}))).then(ids=>done({ids}),error=>done({failure:String(error)}));",[names]).then(result=>{if(result.failure)throw Error(result.failure);});
  }
  readEvents() {return this.exec("return window.__T20_EVENTS__ ?? [];");}
  async find(xpath) {return (await this.request("POST",this.session+"/element",{using:"xpath",value:xpath}))[ELEMENT];}
  async click(xpath) {
    const end=Date.now()+10000;
    for(;;) {try {const id=await this.find(xpath);return await this.request("POST",`${this.session}/element/${id}/click`,{});}catch(error){if(Date.now()>=end||!/stale element reference|no such element/.test(error.message))throw error;await sleep(100);}}
  }
  async enabled(xpath) {return until("exact enabled control "+xpath,()=>this.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!node&&!node.matches(':disabled')&&node.getClientRects().length>0;",[xpath]));}
  async type(xpath,value) {
    const id=await this.find(xpath);await this.request("POST",`${this.session}/element/${id}/clear`,{});return this.request("POST",`${this.session}/element/${id}/value`,{text:value,value:[...value]});
  }
  async set(xpath,value) {
    await this.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;if(!node)throw Error('control missing');const proto=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,arguments[1]);node.dispatchEvent(new Event('input',{bubbles:true}));",[xpath,value]);
  }
  async select(xpath,value) {
    await until("enabled target option",()=>this.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return node&&!node.matches(':disabled')&&[...node.options].some(option=>option.value===arguments[1]&&!option.disabled);",[xpath,value]));
    await this.exec("const node=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;node.value=arguments[1];node.dispatchEvent(new Event('change',{bubbles:true}));",[xpath,value]);
  }
  pick(value) {return this.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];",[value]);}
  key(value) {return this.request("POST",this.session+"/actions",{actions:[{type:"key",id:"keyboard",actions:[{type:"keyDown",value},{type:"keyUp",value}]}]});}
  async controlClick(xpath) {
    await this.request("POST",this.session+"/actions",{actions:[{type:"key",id:"keyboard",actions:[{type:"keyDown",value:"\uE009"}]}]});
    try{return await this.click(xpath);}finally{await this.request("DELETE",this.session+"/actions");}
  }
  async screenshot(name) {writeFileSync(join(this.work,name),Buffer.from(await this.request("GET",this.session+"/screenshot"),"base64"));}
  save(name,value) {writeFileSync(join(this.work,name),JSON.stringify(value,null,2));}
  observeOwned() {
    const script=String.raw`
$ErrorActionPreference='Stop'
function NormalPath([string]$value) { if($null -eq $value){return ''}; return $value.Replace('\','/').ToLowerInvariant() }
function Stamp($item) { return $item.CreationDate.ToUniversalTime().ToString('o') }
$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$app=NormalPath $env:KINSHOKO_T20_EXECUTABLE
$profile=NormalPath $env:KINSHOKO_T20_PROFILE
$tauri=NormalPath $env:KINSHOKO_T20_TAURI_DRIVER
$known=@(ConvertFrom-Json $env:KINSHOKO_T20_OWNED_PROCESSES)
$selected=@{}
foreach($item in $all) {
 $path=NormalPath $item.ExecutablePath; $command=NormalPath $item.CommandLine; $reason=$null
 if($path -eq $app){$reason='exact-application'}
 elseif($command.Contains($profile)){$reason='exact-owned-profile'}
 elseif($item.ProcessId -eq [int]$env:KINSHOKO_T20_DRIVER_PID -and $path -eq $tauri -and $command.Contains('--port 4630') -and $command.Contains('--native-port 4631')){$reason='spawned-driver-path-pid-ports'}
 else {foreach($prior in $known){if($item.ProcessId -eq $prior.pid -and (Stamp $item) -eq $prior.created -and $path -eq (NormalPath $prior.executable)){$reason='previously-observed-owned-process';break}}}
 if($reason){$selected[[string]$item.ProcessId]=$reason}
}
do {
 $added=$false
 foreach($item in $all){if(!$selected.ContainsKey([string]$item.ProcessId) -and $selected.ContainsKey([string]$item.ParentProcessId)){$selected[[string]$item.ProcessId]='child-of-observed-owned-process';$added=$true}}
}while($added)
$processes=@($all | Where-Object {$selected.ContainsKey([string]$_.ProcessId)} | ForEach-Object { @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;executable=$_.ExecutablePath;created=(Stamp $_);commandLine=$_.CommandLine;ownership=$selected[[string]$_.ProcessId]} })
$ports=@([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -in 4630,4631} | ForEach-Object {@{address=[string]$_.Address;port=$_.Port}})
@{processes=$processes;ports=$ports;checkedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 6 -Compress
`;
    const result=spawnSync("powershell",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,encoding:"utf8",env:{...process.env,KINSHOKO_T20_EXECUTABLE:this.application,KINSHOKO_T20_PROFILE:this.profile,KINSHOKO_T20_TAURI_DRIVER:this.tauriDriver,KINSHOKO_T20_DRIVER_PID:String(this.process?.pid??0),KINSHOKO_T20_OWNED_PROCESSES:JSON.stringify(this.ownedProcesses)}});
    if(result.status!==0)throw Error("Exact process/profile/port observation failed: "+result.stderr);
    return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,""));
  }
  rememberOwned(state) {
    for(const process of state.processes)if(!this.ownedProcesses.some(prior=>prior.pid===process.pid&&prior.created===process.created))this.ownedProcesses.push(process);
  }
  async waitReleased(label) {
    let last;
    try {
      last=await until(label,()=>{const state=this.observeOwned();this.rememberOwned(state);last=state;return !state.processes.length&&!state.ports.length?state:null;},15000);
      return last;
    } catch(error) {this.save("release-unconfirmed.json",{status:"failed-release",error:String(error),last});throw error;}
  }
  async normalQuit(label) {
    const receipt=join(this.work,label+"-normal-quit.json");
    const result=spawnSync("python",["e2e/native-tray-exit-t13.py",this.application,receipt],{windowsHide:true,encoding:"utf8",timeout:45000});
    if(result.status!==0)throw Error(`Normal tray Quit failed ${label}: ${result.stderr}`);
    const value=JSON.parse(readFileSync(receipt,"utf8"));if(!value.processEnded)throw Error("Tray Quit did not end the owned process");
    this.record("normal-tray-quit",{label,receipt,value});
    if(this.session)await this.request("DELETE",this.session).catch(error=>this.record("ended-session-delete",{error:String(error)}));this.session=null;
    await this.stopDriver();const released=await this.waitReleased("normal Quit releases exact app/profile/drivers/ports");
    this.record("normal-quit-release",{label,released});
  }
  async stopDriver() {
    const before=this.observeOwned();this.rememberOwned(before);
    const owner=before.processes.find(process=>process.pid===this.process?.pid&&process.ownership==="spawned-driver-path-pid-ports");
    if(owner) {
      const result=spawnSync("taskkill",["/PID",String(owner.pid),"/T","/F"],{windowsHide:true,encoding:"utf8"});
      this.record("owned-driver-stop",{owner,status:result.status,stdout:result.stdout,stderr:result.stderr});
      if(result.status!==0)throw Error("Exact spawned driver termination failed: "+result.stderr);
    }
    this.process=null;
  }
  async cleanup() {
    this.release=null;
    try {
      if(this.session)await this.request("DELETE",this.session).catch(error=>this.record("session-delete-failed",{error:String(error)}));this.session=null;
      const before=this.observeOwned();this.rememberOwned(before);
      const script=String.raw`
$ErrorActionPreference='Stop'
$expected=@(ConvertFrom-Json $env:KINSHOKO_T20_TERMINATE)
function SameInstance($item,$prior) { return $null -ne $item -and $item.CreationDate.ToUniversalTime().ToString('o') -eq $prior.created -and $item.ExecutablePath -eq $prior.executable }
function CurrentProcess($prior) { return Get-CimInstance Win32_Process -Filter ('ProcessId = '+[string][uint32]$prior.pid) -ErrorAction Stop | Select-Object -First 1 }
$terminated=@(); $alreadyEnded=@()
foreach($prior in $expected) {
 $item=CurrentProcess $prior
 if(!(SameInstance $item $prior)){$alreadyEnded+=@{pid=$prior.pid;created=$prior.created;reason='old-instance-no-longer-exists'};continue}
 try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop }
 catch {
  $current=CurrentProcess $prior
  if(SameInstance $current $prior){throw}
  $alreadyEnded+=@{pid=$prior.pid;created=$prior.created;reason='exited-during-exact-stop'};continue
 }
 $terminated+=@{pid=$item.ProcessId;executable=$item.ExecutablePath;created=$prior.created}
}
@{terminated=$terminated;alreadyEnded=$alreadyEnded} | ConvertTo-Json -Depth 4 -Compress
`;
      const forced=spawnSync("powershell",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,encoding:"utf8",env:{...process.env,KINSHOKO_T20_TERMINATE:JSON.stringify(before.processes)}});
      const termination={status:forced.status,stdout:forced.stdout,stderr:forced.stderr};this.record("forced-owned-cleanup",termination);
      if(forced.status!==0)throw Error("Exact owned process cleanup failed: "+forced.stderr);
      const after=await this.waitReleased("cleanup releases exact app/profile/drivers/ports");this.process=null;
      this.release={released:true,before,termination,after};this.save("release.json",this.release);return this.release;
    } catch(error) {
      let remaining;try{remaining=this.observeOwned();this.rememberOwned(remaining);}catch(observation){remaining={unconfirmed:true,error:String(observation)};}
      this.release={released:false,error:String(error),remaining};this.save("release.json",this.release);throw error;
    } finally {this.save("command-trace.json",this.trace);}
  }
}
