// #78 T17: production waterfall capture, current geometry, original pixels and native side effects.
// node e2e/wall-capture.mjs <frozen kinshoko.exe> <msedgedriver.exe> <build-source.json> [--race-only]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
const [, , appArg, edgeArg, manifestArg] = process.argv;
if (!appArg || !edgeArg || !manifestArg) throw new Error("node e2e/wall-capture.mjs <kinshoko.exe> <msedgedriver.exe> <build-source.json> [--race-only]");
const raceOnly = process.argv.includes("--race-only");
const application = resolve(appArg), port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4592);
const work = resolve("work/e2e", `wall-capture-${raceOnly ? "race-" : ""}${Date.now()}`);
for (const path of [work, join(work,"libraries"), join(work,"sources"), join(work,"app-data"), join(work,"webview")]) mkdirSync(path,{recursive:true});
const manifest = JSON.parse(readFileSync(manifestArg,"utf8").replace(/^\uFEFF/,""));
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const result = { status:"running", source:manifest.source, tree:manifest.tree, binarySha256:sha(application), application, manifest:resolve(manifestArg), scriptSha256:sha(new URL(import.meta.url)), scriptSource:spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:true}).stdout.trim(), mode:raceOnly?"clipboard-revocation":"wall", assertions:[], samples:[], work, startedAt:new Date().toISOString() };
if(result.binarySha256!==manifest.binarySha256.toLowerCase()) throw new Error("Binary differs from frozen source manifest");
const checksum = Array.from({length:256},(_,c)=>{for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const b of body)crc=checksum[(crc^b)&255]^(crc>>>8);const len=Buffer.alloc(4),tail=Buffer.alloc(4);len.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([len,body,tail]);}
function png(path,width,height,seed=0){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;const bytes=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*(width*4+1)+1+x*4;bytes[p]=(x+seed)%256;bytes[p+1]=y%256;bytes[p+2]=x%2*255;bytes[p+3]=255;}writeFileSync(path,Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",header),chunk("IDAT",deflateSync(bytes)),chunk("IEND",Buffer.alloc(0))]));}
const detail=join(work,"sources",raceOnly?"slow-original.png":"original-detail.png");
const originalWidth=raceOnly?10000:4800,originalHeight=raceOnly?8000:3200;
png(detail,originalWidth,originalHeight);
const sourceHash=sha(detail);
const endpoint=`http://127.0.0.1:${port}`, ELEMENT="element-6066-11e4-a52e-4f735466cecf";
async function wd(method,path,body){const r=await fetch(endpoint+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const v=await r.json();if(!r.ok||v.value?.error)throw new Error(`${method} ${path}: ${JSON.stringify(v.value)}`);return v.value;}
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function until(label,read,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await read();if(v)return v;}catch(e){last=e;}await delay(100);}throw new Error(`Timed out ${label}${last?`: ${last.message}`:""}`);}
function check(value,label){if(!value)throw new Error(label);result.assertions.push(label);console.log(`PASS ${label}`);}
let base, driver, occluder;
const exec=(script,args=[])=>wd("POST",`${base}/execute/sync`,{script,args});
async function invoke(command,args={}){const v=await wd("POST",`${base}/execute/async`,{script:"const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({failure:String(error)}));",args:[command,args]});if(v.failure)throw new Error(`${command}: ${v.failure}`);return v.value;}
const library=(name,args)=>invoke(`plugin:library|${name}`,args), desktop=(name,args)=>invoke(`plugin:desktop|${name}`,args);
const native=(name,label="main",args={})=>invoke(`plugin:window|${name}`,{label,...args});
const windows=()=>invoke("plugin:window|get_all_windows");
const click=async(xpath)=>wd("POST",`${base}/element/${(await wd("POST",`${base}/element`,{using:"xpath",value:xpath}))[ELEMENT]}/click`,{});
const screenshot=async(name)=>writeFileSync(join(work,name),Buffer.from(await wd("GET",`${base}/screenshot`),"base64"));
async function startSession(){const dpr=process.env.KINSHOKO_CAPTURE_DPR;const s=await wd("POST","/session",{capabilities:{alwaysMatch:{"tauri:options":{application,webviewOptions:{userDataFolder:join(work,"webview"),additionalBrowserArguments:dpr?[`force-device-scale-factor=${Number(dpr)}`]:[]}}}}});base=`/session/${s.sessionId}`;await wd("POST",`${base}/timeouts`,{script:120000});await until("IPC ready",()=>exec("return !!window.__TAURI_INTERNALS__?.invoke"));result.capabilities=s.capabilities;}
async function reload(){const marker=Date.now()+Math.random();await exec("window.__reloadMarker=arguments[0];location.reload()",[marker]);await until("new wall document",()=>exec("return window.__reloadMarker!==arguments[0]&&!!document.querySelector('.wall')",[marker]));if(await exec("return !!document.querySelector('.import-popup:not([hidden])')"))await click("//button[@aria-label='关闭导入操作']");await observeRequests();}
async function observeRequests(){
 const descriptor=await exec("const d=Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__,'invoke');return {writable:d?.writable,configurable:d?.configurable,hasSetter:!!d?.set}");
 result.invokeDescriptor=descriptor;
 await wd("POST",`${base}/execute/async`,{script:"const done=arguments[arguments.length-1];if(window.__captureRequests){done(true);return;}window.__captureRequests=[];window.__documentMarker=crypto.randomUUID();const handler=window.__TAURI_INTERNALS__.transformCallback(e=>{window.__captureRequests.push(e.payload.request);if(window.__lateReport){const late=window.__lateReport;window.__lateReport=null;window.__lateSent=late;setTimeout(()=>window.__TAURI_INTERNALS__.invoke('plugin:desktop|report_capture_references',late),5);}});window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'capture-reference-request',target:{kind:'Any'},handler}).then(()=>done(true),error=>done({failure:String(error)}));",args:[]});
}
async function staleInput(){const requests=await exec("return window.__captureRequests");check(requests.length>=2,"public production capture requests are observed without replacing immutable invoke");return {request:requests[0],frame:{instance:"stale-harness-input",generation:0,dpr:await exec("return devicePixelRatio"),references:[]}};}
async function importFiles(info,paths){const id=await library("start_import",{libraryId:info.id,source:{paths},destination:{libraryId:info.id,folderId:null}});return until("import complete",async()=>{const task=(await library("import_tasks")).find(t=>t.taskId===id);if(task?.report&&!task.finishing){check(task.report.items.every(i=>["imported","merged"].includes(i.outcome.kind)),"synthetic originals import through production task");return task.report;}return null;},120000);}
const browse=(id,safeMode=true)=>library("workspace_browse",{query:{scope:{kind:"library",libraryId:id,scope:{kind:"all"}},conditions:{conditions:[]},cursor:null,limit:500,thumbnailPx:256},safeMode});
async function shownCard(contentId){const box=await until("loaded visible waterfall image",()=>exec("const card=[...document.querySelectorAll('.card')].find(n=>n.dataset.id===arguments[0]);const i=card?.querySelector('img');if(!i?.complete||!i.naturalWidth||card.dataset.veiled==='true')return null;const b=i.getBoundingClientRect(),v=document.querySelector('.wall').getBoundingClientRect();if(b.bottom<=v.top||b.top>=v.bottom)return null;return {left:b.left,top:b.top,width:b.width,height:b.height,dpr:devicePixelRatio,thumbWidth:i.naturalWidth};",[contentId]));const scale=Math.min(box.width/originalWidth,box.height/originalHeight),dpr=box.dpr;const left=Math.round((box.left+(box.width-originalWidth*scale)/2)*dpr),top=Math.round((box.top+(box.height-originalHeight*scale)/2)*dpr);const right=Math.round((box.left+(box.width+originalWidth*scale)/2)*dpr),bottom=Math.round((box.top+(box.height+originalHeight*scale)/2)*dpr);const origin=await native("inner_position");return {...box,x:origin.x+left,y:origin.y+top,width:right-left,height:bottom-top};}
async function bottomOriginal(contentId){await until("original visible after real paginated wall scroll",async()=>{await exec("const w=document.querySelector('.wall');w.scrollTop=w.scrollHeight;w.dispatchEvent(new Event('scroll',{bubbles:true}));");return exec("const n=[...document.querySelectorAll('.card')].find(n=>n.dataset.id===arguments[0]),i=n?.querySelector('img'),w=document.querySelector('.wall');if(!i?.complete||!i.naturalWidth)return false;const b=i.getBoundingClientRect(),v=w.getBoundingClientRect();return b.bottom>v.top&&b.top<v.bottom",[contentId]);});return shownCard(contentId);}
async function begin(){if(await exec("return !!document.querySelector('.import-popup:not([hidden])')"))await click("//button[@aria-label='关闭导入操作']");await desktop("start_capture");await until("frozen native window",()=>native("is_visible","capture"));const frozen=await desktop("frozen_screen");return {frozen,token:frozen.image.slice("screen/".length),origin:await native("inner_position","capture")};}
function selection(shown,capture){const offsetX=Math.max(4,Math.floor(shown.width/4)),offsetY=Math.max(4,Math.floor(shown.height/4)),width=Math.max(4,Math.floor(shown.width/8)),height=Math.max(4,Math.floor(shown.height/8));return {region:{x:shown.x+offsetX-capture.origin.x,y:shown.y+offsetY-capture.origin.y,width,height},crop:{x:Math.floor(offsetX*originalWidth/shown.width),y:Math.floor(offsetY*originalHeight/shown.height),width:Math.ceil((offsetX+width)*originalWidth/shown.width)-Math.floor(offsetX*originalWidth/shown.width),height:Math.ceil((offsetY+height)*originalHeight/shown.height)-Math.floor(offsetY*originalHeight/shown.height)}};}
async function capture(shown,action){const before=await windows(),frozen=await begin(),selected=selection(shown,frozen);await desktop("finish_capture",{token:frozen.token,region:selected.region,action});let pin;if(action==="pin"){const label=await until("new native reference pin",async()=>(await windows()).find(w=>w.startsWith("pin-")&&!before.includes(w)));pin=await desktop("pin_frame",{pin:label.slice(4)});await until("native pin shown",()=>native("is_visible",label));}return {...selected,pin};}
async function clearPins(){const main=await wd("GET",`${base}/window`);for(const handle of await wd("GET",`${base}/window/handles`)){if(handle===main)continue;await wd("POST",`${base}/window`,{handle});const label=await exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label");if(label.startsWith("pin-"))await exec("void window.__TAURI_INTERNALS__.invoke('plugin:desktop|close_pin',{pin:arguments[0]});return true",[label.slice(4)]);await wd("POST",`${base}/window`,{handle:main});if(label.startsWith("pin-"))await until("own pin closed",async()=>!(await windows()).includes(label));}}
function clipboardFile(entry){const path=join(work,"app-data","captures",`${entry.id}.png`);copyFileSync(path,join(work,`clipboard-${entry.id}.png`));const r=spawnSync(process.env.KINSHOKO_PYTHON??"python",["-c","from PIL import Image; import json,sys; im=Image.open(sys.argv[1]).convert('RGBA'); print(json.dumps({'size':im.size,'corners':[im.getpixel((0,0)),im.getpixel((im.width-1,0)),im.getpixel((0,im.height-1)),im.getpixel((im.width-1,im.height-1))]}))",path],{encoding:"utf8",windowsHide:true});if(r.status!==0)throw new Error(r.stderr);return JSON.parse(r.stdout);}
function corners(crop){return [[crop.x,crop.y],[crop.x+crop.width-1,crop.y],[crop.x,crop.y+crop.height-1],[crop.x+crop.width-1,crop.y+crop.height-1]].map(([x,y])=>[x%256,y%256,x%2*255,255]);}
async function verifyOriginal(shown,source,label){await clearPins();const before=(await desktop("capture_history")).length;const copy=await capture(shown,"copy");check((await desktop("capture_history")).length===before,`${label}: original copy adds no screenshot history`);const pinned=await capture(shown,"pin"),pin=pinned.pin.pin;const sample={label,shown,copy,pinned,pin};result.samples.push(sample);check(pin.content.kind==="reference"&&pin.content.libraryId===source.libraryId&&pin.content.imageId===source.imageId,`${label}: pin keeps exact library/image source`);check(isDeepStrictEqual(pin.crop,pinned.crop),`${label}: pin preserves original pixel crop`);check((await desktop("capture_history")).length===before,`${label}: reference pin adds no screenshot history`);await desktop("pin_clipboard");const entry=(await desktop("capture_history"))[0],clipboard=clipboardFile(entry);check(JSON.stringify(clipboard.size)===JSON.stringify([copy.crop.width,copy.crop.height]),`${label}: actual OS clipboard retains original crop dimensions`);check(JSON.stringify(clipboard.corners)===JSON.stringify(corners(copy.crop)),`${label}: actual OS clipboard retains original fine-detail corner bytes`);sample.clipboard=clipboard;await clearPins();}
function mainHwnd(){const r=spawnSync("powershell",["-NoProfile","-NonInteractive","-Command","Add-Type -AssemblyName UIAutomationClient; $owned=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | Select-Object -First 1; if($owned){$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$owned.ProcessId); [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition) | Where-Object { $_.Current.Name -eq 'Kinshoko' } | ForEach-Object { $_.Current.NativeWindowHandle }}"],{env:{...process.env,KINSHOKO_E2E_EXECUTABLE:application},encoding:"utf8",windowsHide:true});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim().split(/\s+/).filter(Boolean).map(Number);}
function killOwn(){return spawnSync("powershell",["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],{env:{...process.env,KINSHOKO_E2E_EXECUTABLE:application},encoding:"utf8",windowsHide:true});}
try{
 driver=spawn(process.env.KINSHOKO_TAURI_DRIVER??"C:/Users/yuk1no/.cargo/bin/tauri-driver.exe",["--port",String(port),"--native-port",String(port+1),"--native-driver",resolve(edgeArg)],{env:{...process.env,KINSHOKO_DATA_DIR:join(work,"app-data"),KINSHOKO_SKIP_AUTOSTART:"1",WEBVIEW2_USER_DATA_FOLDER:join(work,"webview")},stdio:["ignore","inherit","inherit"],windowsHide:true});
 await until("driver",()=>fetch(endpoint+"/status").then(r=>r.ok));await startSession();
 result.environment=await invoke("diagnostics_report",{purpose:"T17 original wall capture"});
 const first=await library("create_library",{parent:join(work,"libraries"),name:"原图来源 A"});await importFiles(first,[detail]);
 const firstCard=(await browse(first.id)).cards[0];result.first={info:first,card:firstCard};
 if(raceOnly){
  await library("set_safe_mode",{on:false});await library("edit",{libraryId:first.id,ids:[firstCard.imageId],edits:[{kind:"setRating",rating:"explicit"}]});await reload();await until("adult visible with global mode off",()=>exec("return document.querySelector('.card')?.dataset.veiled==='false'"));
  const seed=await begin(),mainOrigin=await native("inner_position");
  await desktop("finish_capture",{token:seed.token,region:{x:mainOrigin.x+20-seed.origin.x,y:mainOrigin.y+20-seed.origin.y,width:8,height:8},action:"copy"});
  result.clipboardSeed={width:8,height:8,history:(await desktop("capture_history")).length};
  const shown=await bottomOriginal(firstCard.id),frozen=await begin(),selected=selection(shown,frozen);
  result.race={shown,selected,startedAt:new Date().toISOString()};
  await exec("window.__copyResult={pending:true}; window.__TAURI_INTERNALS__.invoke('plugin:desktop|finish_capture',arguments[0]).then(()=>window.__copyResult={ok:true,at:Date.now()},error=>window.__copyResult={error:String(error),at:Date.now()});",[{token:frozen.token,region:selected.region,action:"copy"}]);
  await delay(Number(process.env.KINSHOKO_RACE_DELAY??400));
  result.race.beforeRevocation=await exec("return window.__copyResult");
  check(result.race.beforeRevocation.pending===true,"slow decode is genuinely still running before mode revocation");
  result.race.modeRequestAt=new Date().toISOString();await library("set_safe_mode",{on:true});result.race.modeReturnedAt=new Date().toISOString();result.race.modeReturnedUnix=Date.now();
  result.race.copy=await until("slow original completion",()=>exec("return window.__copyResult&&!window.__copyResult.pending?window.__copyResult:null"),120000);
  result.race.completedAfterRevocation=result.race.copy.at>=result.race.modeReturnedUnix;
  await desktop("pin_clipboard");const entry=(await desktop("capture_history"))[0];result.race.clipboard=clipboardFile(entry);
  result.race.containsOriginal=JSON.stringify(result.race.clipboard.size)===JSON.stringify([selected.crop.width,selected.crop.height])&&JSON.stringify(result.race.clipboard.corners)===JSON.stringify(corners(selected.crop));
  check(!result.race.copy.ok&&!result.race.containsOriginal,"safe-mode revocation during slow original decode cannot commit late original pixels to the real OS clipboard");
 }else{
  const second=await library("create_library",{parent:join(work,"libraries"),name:"当前独立库 B"});await importFiles(second,[detail]);await reload();
  let shown=await bottomOriginal(firstCard.id);check(shown.thumbWidth<originalWidth,"formal waterfall displays a reduced derivative of the high-resolution original");result.dpr=shown.dpr;
  if(process.env.KINSHOKO_CAPTURE_DPR)check(Math.abs(shown.dpr-Number(process.env.KINSHOKO_CAPTURE_DPR))<.001,"requested WebView DPR is actual; this is not system DPI acceptance");
  let aggregate=(await library("workspace_browse",{query:{scope:{kind:"all"},conditions:{conditions:[]},cursor:null,limit:500,thumbnailPx:256},safeMode:true})).cards.find(c=>c.id===firstCard.id);
  check(aggregate.sources.length===2,"real identical originals aggregate with two independent registered sources");
  await verifyOriginal(shown,aggregate,"initial aggregate waterfall");await screenshot("wall-original-reference.png");
  const prior=await begin();await desktop("cancel_capture",{token:prior.token});const fresh=await begin();
  await desktop("cancel_capture",{token:prior.token});check((await desktop("frozen_screen"))?.image===fresh.frozen.image,"late old cancel does not close the next native capture");
  const selected=selection(shown,fresh);const rejected=await desktop("finish_capture",{token:prior.token,region:selected.region,action:"copy"}).then(()=>false,()=>true);check(rejected&&(await desktop("frozen_screen"))?.image===fresh.frozen.image,"late old finish cannot consume a new native capture");await desktop("cancel_capture",{token:fresh.token});
  result.staleInput=await staleInput();await exec("window.__lateReport=arguments[0]",[result.staleInput]);
  await verifyOriginal(await bottomOriginal(firstCard.id),aggregate,"late prior source report");
  // Add unique content to force actual virtualization, then scroll out and back before F1.
  const extra=Array.from({length:120},(_,i)=>{const path=join(work,"sources",`other-${i}.png`);png(path,80+(i%3)*20,100+(i%4)*30,i+1);return path;});await importFiles(second,extra);await reload();
  await until("updated 121-card production wall",()=>exec("return document.querySelector('.wall')?.dataset.total==='121'&&document.querySelector('.card img')?.complete"));
  await exec("const w=document.querySelector('.wall');w.scrollTop=0;w.dispatchEvent(new Event('scroll',{bubbles:true}));");
  await until("top population before virtual scroll",()=>exec("return document.querySelector('.wall').scrollTop<1&&document.querySelectorAll('.card').length>0&&![...document.querySelectorAll('.card')].some(n=>n.dataset.id===arguments[0])",[firstCard.id]));
  const initialIds=await exec("return [...document.querySelectorAll('.card')].map(n=>n.dataset.id)");result.virtualScroll={initialIds};
  await exec("const el=document.querySelector('.wall');el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));");
  await until("recycled bottom population",()=>exec("return [...document.querySelectorAll('.card')].some(n=>!arguments[0].includes(n.dataset.id))",[initialIds]));
  result.virtualScroll.bottomIds=await exec("return [...document.querySelectorAll('.card')].map(n=>n.dataset.id)");check(result.virtualScroll.bottomIds.some(id=>!initialIds.includes(id)),"actual virtualized wall recycles visible card population");
  await bottomOriginal(firstCard.id);
  await exec("const el=document.querySelector('.wall');el.scrollTop=0;el.dispatchEvent(new Event('scroll',{bubbles:true}));");
  await until("original virtualized out",()=>exec("return ![...document.querySelectorAll('.card')].some(n=>n.dataset.id===arguments[0])",[firstCard.id]));
  await exec("const el=document.querySelector('.wall');el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));");
  shown=await bottomOriginal(firstCard.id);await verifyOriginal(shown,aggregate,"immediate virtual return");
  const size=await native("inner_size");await native("set_size","main",{value:{type:"Physical",data:{width:Math.max(850,size.width-220),height:size.height}}});
  await verifyOriginal(await bottomOriginal(firstCard.id),aggregate,"native width reflow");
  await native("set_size","main",{value:{type:"Physical",data:size}});await verifyOriginal(await bottomOriginal(firstCard.id),aggregate,"continuous resize return");
  const priorInstance=await exec("return window.__documentMarker");
  await reload();
  await exec("const el=document.querySelector('.wall');el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));");
  await verifyOriginal(await bottomOriginal(firstCard.id),aggregate,"document re-creation");
  check((await exec("return window.__documentMarker"))!==priorInstance,"real WebView document is re-created before the next source handshake");
  // Destroy and re-create the real main HWND while a reference pin keeps the WebDriver browser alive.
  const oldReport=await staleInput();
  const oldHandle=await wd("GET",`${base}/window`),oldNative=mainHwnd();
  const beforeHandles=await wd("GET",`${base}/window/handles`);
  await capture(await bottomOriginal(firstCard.id),"pin");
  const survivor=await until("spare native WebView",async()=>(await wd("GET",`${base}/window/handles`)).find(h=>!beforeHandles.includes(h)));
  await wd("DELETE",`${base}/window`);await wd("POST",`${base}/window`,{handle:survivor});
  const reopen=spawn(application,[],{env:{...process.env,KINSHOKO_DATA_DIR:join(work,"app-data"),KINSHOKO_SKIP_AUTOSTART:"1",WEBVIEW2_USER_DATA_FOLDER:join(work,"webview")},windowsHide:true,stdio:"ignore"});
  await new Promise((done,reject)=>{reopen.once("error",reject);reopen.once("exit",done);});
  const newHandle=await until("re-created native main window",async()=>(await wd("GET",`${base}/window/handles`)).find(h=>h!==oldHandle&&h!==survivor));
  await wd("POST",`${base}/window`,{handle:newHandle});await until("re-created formal wall",()=>exec("return !!document.querySelector('.wall')"));await observeRequests();
  await exec("window.__lateReport=arguments[0];const el=document.querySelector('.wall');el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));",[oldReport]);
  const newNative=mainHwnd();result.hwndRecreation={oldHandle,newHandle,oldNative,newNative};
  check(oldNative.length===1&&newNative.length===1&&oldNative[0]!==newNative[0],"real main HWND is destroyed and re-created");
  await verifyOriginal(await bottomOriginal(firstCard.id),aggregate,"native HWND re-creation with late old report");
  // Cross-card/toolbar regions stay ordinary screen captures.
  const ordinaryBefore=(await desktop("capture_history")).length, outside=await begin();await desktop("finish_capture",{token:outside.token,region:{x:(await native("inner_position")).x+30-outside.origin.x,y:(await native("inner_position")).y+30-outside.origin.y,width:80,height:60},action:"copy"});const ordinary=(await desktop("capture_history"))[0];check((await desktop("capture_history")).length===ordinaryBefore+1&&ordinary.width===80&&ordinary.height===60,"outside a single reference remains a native screen capture");
  // A genuine topmost external native window occludes the source.
  shown=await bottomOriginal(firstCard.id);const covering={x:shown.x+Math.floor(shown.width/4)-8,y:shown.y+Math.floor(shown.height/4)-8,width:Math.floor(shown.width/8)+30,height:Math.floor(shown.height/8)+30};
  const formScript=join(work,"occluder.ps1");writeFileSync(formScript,`Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$f=New-Object System.Windows.Forms.Form\n$f.FormBorderStyle='None'\n$f.StartPosition='Manual'\n$f.Location=New-Object System.Drawing.Point(${covering.x},${covering.y})\n$f.ClientSize=New-Object System.Drawing.Size(${covering.width},${covering.height})\n$f.TopMost=$true\n$f.BackColor=[System.Drawing.Color]::FromArgb(3,17,229)\n$f.Add_Shown({[IO.File]::WriteAllText('${join(work,"occluder-ready.txt").replaceAll("'","''")}','ready')})\n[System.Windows.Forms.Application]::Run($f)\n`);
  occluder=spawn("powershell",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-STA","-File",formScript],{windowsHide:true,stdio:"ignore"});await until("real external HWND visible",()=>{try{return readFileSync(join(work,"occluder-ready.txt"),"utf8")==="ready";}catch{return false;}});
  const coveredBefore=(await desktop("capture_history")).length;const coveredCopy=await capture(shown,"copy");check((await desktop("capture_history")).length===coveredBefore+1,"external topmost HWND prevents original-source capture under its coverage");const coveredEntry=(await desktop("capture_history"))[0];check(coveredEntry.width===coveredCopy.region.width&&coveredEntry.height===coveredCopy.region.height,"native occluded selection preserves screen rather than original dimensions");occluder.kill();occluder=null;
  check(sha(detail)===sourceHash,"original high-resolution file bytes remain unchanged");
  result.requests=await exec("return window.__captureRequests");result.lateSent=await exec("return window.__lateSent");await screenshot("wall-after-reflow-and-capture.png");
 }
 result.status="passed";
}catch(error){result.status="failed";result.error=error.stack??String(error);if(base){await screenshot("failure.png").catch(()=>{});await exec("return document.documentElement.outerHTML").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});result.requests=await exec("return window.__captureRequests").catch(()=>undefined);result.lateSent=await exec("return window.__lateSent").catch(()=>undefined);}console.error(error);process.exitCode=1;
}finally{
 result.finishedAt=new Date().toISOString();writeFileSync(join(work,"result.json"),JSON.stringify(result,null,2));if(occluder)occluder.kill();if(base)await wd("DELETE",base).catch(()=>{});killOwn();if(driver?.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});console.log(`Evidence: ${work}`);
}
