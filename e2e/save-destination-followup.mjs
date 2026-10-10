// #78 T10 native follow-up: visible running owner and copy confirmation after source refresh.
// Setup uses public Tauri actions; curation uses the rendered explicit-source controls.
// Usage: node e2e/save-destination-followup.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/save-destination-followup.mjs <owned kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `save-destination-followup-${Date.now()}`);
mkdirSync(work, { recursive: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
const imagePath = join(work, "image.png");
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const width = 160, height = 120;
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
const pixels = Buffer.alloc(height * (1 + width * 3));
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (1 + width * 3) + 1 + x * 3; pixels[offset] = 70 + x; pixels[offset + 1] = 60 + y; pixels[offset + 2] = 140; }
writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
const port = 4586;
const driverUrl = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
async function wd(method, path, body) {
  const response = await fetch(driverUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, read, timeout = 30000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const result = await read(); if (result) return result; } catch (reason) { error = reason; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
}
const assertions = [];
function assert(ok, label) { if (!ok) throw new Error(label); assertions.push(label); console.log(`PASS ${label}`); }
class Session {
  static async start() {
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
    const session = new Session(result.sessionId);
    await until("Tauri IPC ready", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async desktop(command, args = {}) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:desktop|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async type(xpath, value) {
    const id = await this.find(xpath);
    await wd("POST", `${this.base}/element/${id}/clear`, {});
    return wd("POST", `${this.base}/element/${id}/value`, { text: value, value: [...value] });
  }
  async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
  async click(xpath) {
    const end = Date.now() + 10000;
    for (;;) {
      try { const id = await this.find(xpath); return await wd("POST", `${this.base}/element/${id}/click`, {}); }
      catch (error) {
        // These WebDriver errors mean the click did not run. Resolve the refreshed control once more.
        if (Date.now() >= end || !/stale element reference|no such element/.test(String(error))) throw error;
        await delay(150);
      }
    }
  }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}

const appData = join(work, "app-data");
const scriptSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const scriptSha256 = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
const manifestPath = resolve(process.argv[4] ?? "work/e2e/t10-build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
if (manifest.binarySha256.toLowerCase() !== binarySha256) throw new Error("Binary does not match the build manifest");
const source = manifest.source;
const sourceTree = spawnSync("git", ["rev-parse", source + "^{tree}"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const provenance = { scriptSource, scriptSha256, sourceTree, manifestPath, driverSha256: createHash("sha256").update(readFileSync(resolve(edgeArg))).digest("hex") };
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4587", "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: appData, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});

let session, a, b, c, environment;
const receipts=[];
const query={scope:{kind:"all"},conditions:{conditions:[]},cursor:null,limit:100,thumbnailPx:128};
const local=(libraryId,folderId=null)=>session.invoke("workspace_browse",{query:{...query,scope:{kind:"library",libraryId,scope:folderId?{kind:"folder",id:folderId}:{kind:"all"}}},safeMode:true});
const task=async id=>(await session.invoke("import_tasks")).find(t=>t.taskId===id);
const finish=id=>until("real completed receipt "+id,async()=>{const t=await task(id);return t?.report&&!t.finishing?t:null;},90000);
// #98 redesign: the import split button picks first, then a dialog chooses 图库 and 文件夹 (named by their
// visible labels); progress and results are bottom-right .k-task cards; the current library is the sidebar
// title menu; the browse scope is the 查找范围 nav. Steps use roles and accessible names.
const lit=value=>value.includes("'")?`concat('${value.split("'").join(`',"'",'`)}')`:`'${value}'`;
const dialogX=name=>`//*[@role='dialog' and (@aria-label=${lit(name)} or @aria-labelledby=//*[normalize-space()=${lit(name)}]/@id)]`;
const importDialog=dialogX("导入图片"),eagleDialog=dialogX("从 Eagle 导入");
const libraryChoice=prefix=>`${prefix}//label[span[@class='k-field-label' and contains(normalize-space(),'图库')]]//select`;
const folderChoice=prefix=>`${prefix}//label[span[@class='k-field-label' and normalize-space()='文件夹']]//select`;
const shown=xpath=>session.exec("const n=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!n&&n.getClientRects().length>0&&!n.disabled;",[xpath]);
const setSelect=async(xpath,value)=>{
 await until("choice loaded "+xpath,()=>session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!s&&s.getClientRects().length>0&&!s.disabled&&[...s.options].some(o=>o.value===arguments[1]&&!o.disabled);",[xpath,value]));
 await session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;s.value=arguments[1];s.dispatchEvent(new Event('change',{bubbles:true}));",[xpath,value]);
 await until("choice applied "+xpath,()=>session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return s?.value===arguments[1];",[xpath,value]));
};
const choose=async(libraryId,folderId=null,prefix=importDialog)=>{await setSelect(libraryChoice(prefix),libraryId);await setSelect(folderChoice(prefix),folderId??"");};
const pick=value=>session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];",[value]);
const readyClick=async xpath=>{await until("enabled "+xpath,()=>shown(xpath));await session.click(xpath);};
// Opening the import dialog by picking files first; the dialog then asks where to save.
const openImport=async paths=>{await pick(paths);await readyClick("//button[@aria-label='导入图片文件']");await until("import dialog",()=>shown(libraryChoice(importDialog)));};
async function startOpened(libraryId,folderId=null,prefix=importDialog){
 const previous=new Set((await session.invoke("import_tasks")).map(t=>t.taskId));
 await choose(libraryId,folderId,prefix);
 await readyClick(`${prefix}//button[normalize-space()='开始导入']`);
 const receipt=await until("new owned import",async()=>(await session.invoke("import_tasks")).find(t=>!previous.has(t.taskId)));
 return receipt.taskId;
}
async function begin(paths,libraryId,folderId=null,eagle=false){
 if(eagle){await pick(paths[0]);await readyClick("//button[@aria-label='更多导入方式']");await readyClick("//*[@role='menu']//*[@role='menuitem' and normalize-space()='整个文件夹…']");await until("Eagle import dialog",()=>shown(libraryChoice(eagleDialog)));return startOpened(libraryId,folderId,eagleDialog);}
 await openImport(paths);return startOpened(libraryId,folderId);
}
const exists=xpath=>session.exec("return !!document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;",[xpath]);
// While an import runs the import button is disabled by design; the next save target is chosen in another
// save-destination dialog (导入参考组包), then that dialog is cancelled without saving anything.
const chooseNextTarget=async(libraryId,folderId=null)=>{
 await openPane("参考组");await readyClick("//button[normalize-space()='导入参考组包']");
 const dialog=dialogX("导入参考组包");await choose(libraryId,folderId,dialog);
 await readyClick(`${dialog}//button[normalize-space()='取消']`);await until("package dialog closed",async()=>!await shown(dialog));
 await openPane("图片与文件夹");
};
const openPane=async name=>{if(await session.exec("return document.querySelector('nav[aria-label=主导航] button[aria-label=\"'+arguments[0]+'\"]')?.getAttribute('aria-expanded')!=='true';",[name]))await readyClick(`//nav[@aria-label='主导航']//button[@aria-label=${lit(name)}]`);await until("pane open "+name,()=>session.exec("return document.querySelector('nav[aria-label=主导航] button[aria-label=\"'+arguments[0]+'\"]')?.getAttribute('aria-expanded')==='true';",[name]));};
const shownCurrentName=name=>session.exec("return document.querySelector('button[aria-label^=\"当前图库：\"]')?.getAttribute('aria-label')===arguments[0];",["当前图库："+name]);
const browseAll=async()=>{await openPane("图片与文件夹");const xpath="//nav[@aria-label='查找范围']//button[normalize-space()='全部图片']";await readyClick(xpath);await until("all images scope",()=>session.exec("const n=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return n?.getAttribute('aria-current')==='page';",[xpath]));};
const runningCard="//section[contains(@class,'k-task') and @aria-label='导入进度']";
const createLibraryFromMenu=async(name,parent)=>{
 await readyClick("//button[starts-with(@aria-label,'当前图库：')]");
 await readyClick("//*[@role='menu' and @aria-label='图库']//*[@role='menuitem' and normalize-space()='新建图库…']");
 await session.type("//label[contains(.,'图库名称')]/input",name);
 await pick(parent);
 await readyClick("//button[normalize-space()='选择存放位置…']");
 await readyClick("//button[normalize-space()='建立图库']");
};
// End only this run's own application processes: descendants of this run's tauri-driver PID.
function ownAppPids(){
 const r=spawnSync("powershell",["-NoProfile","-NonInteractive","-Command","$all=Get-CimInstance Win32_Process;$set=@([int]$env:KINSHOKO_E2E_DRIVER);do{$n=$set.Count;$set=@($set+($all|Where-Object{$set -contains [int]$_.ParentProcessId}|ForEach-Object{[int]$_.ProcessId})|Select-Object -Unique)}while($set.Count -ne $n);$all|Where-Object{$set -contains [int]$_.ProcessId -and $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE}|ForEach-Object{$_.ProcessId}"],{env:{...process.env,KINSHOKO_E2E_DRIVER:String(driver.pid),KINSHOKO_E2E_EXECUTABLE:application},encoding:"utf8",windowsHide:true});
 return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
function quitOwnApp(){for(const pid of ownAppPids())spawnSync("taskkill",["/PID",String(pid),"/F"],{stdio:"ignore",windowsHide:true});}

const running=id=>until("import is still running",async()=>{const t=await task(id);if(t?.report)throw new Error("Fixture completed before running-state operation");return t?.progress.done>0&&t.progress.done<t.progress.total?t:null;});
const stopApp=async()=>{if(session)await session.close().catch(()=>{});session=null;quitOwnApp();await delay(800);};
try{
 await until("driver",()=>fetch(driverUrl+"/status").then(r=>r.ok));
 session=await Session.start();
 environment=await session.exec("return {userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight};");
 a=await session.invoke("create_library",{parent:libraries,name:"浏览库 A"});
 b=await session.invoke("create_library",{parent:libraries,name:"保存库 B"});
 const aFolder=await session.invoke("create_folder",{libraryId:a.id,name:"A 独立目录",parent:null}).catch(async()=>{
   await session.invoke("switch_library",{libraryId:a.id});return session.invoke("create_folder",{libraryId:a.id,name:"A 独立目录",parent:null});
 });
 await session.invoke("switch_library",{libraryId:b.id});
 const bFolder=await session.invoke("create_folder",{libraryId:b.id,name:"B 最终目录",parent:null});
 await session.invoke("switch_library",{libraryId:a.id});
 await session.exec("location.reload();");
 await until("formal current A",()=>shownCurrentName("浏览库 A"));
 await openImport([imagePath]);
 assert(await session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!s&&s.value==='';",[libraryChoice(importDialog)]),"global import begins with an explicit unchosen destination");
 const first=await startOpened(b.id,bFolder);
 const firstReceipt=await finish(first);receipts.push(firstReceipt);
 assert(firstReceipt.destination.libraryId===b.id&&firstReceipt.destination.folderId===bFolder,"ordinary import receipt keeps the submitted library and folder");
 assert((await local(b.id,bFolder)).total===1&&(await local(a.id)).total===0,"ordinary file is committed into B folder while A remains empty");
 assert((await session.invoke("current_library")).id===a.id,"saving into B does not activate B or change browsing current A");
 await session.screenshot("explicit-import-destination.png");
 if(process.argv.includes("--copy-only")){
   c=await session.invoke("create_library",{parent:libraries,name:"新浏览库 C"});
   await session.exec("location.reload();");
   await until("formal current C",()=>shownCurrentName("新浏览库 C"));
 }else{
 const long=await begin(Array(2000).fill(imagePath),b.id,bFolder);
 const before=await running(long);receipts.push({phase:"before-current-create-target-change",receipt:before});
 // The actual new-library page must preserve the running task while its current provider changes.
 await createLibraryFromMenu("新浏览库 C",libraries);
 c=await until("created current C",async()=>{const value=await session.invoke("current_library");return value?.name==="新浏览库 C"?value:null;});
 await until("formal current C",()=>shownCurrentName("新浏览库 C"));
 await chooseNextTarget(a.id,aFolder);
 await browseAll();
 const during=await task(long);receipts.push({phase:"after-current-create-target-change",receipt:during});
 assert(during.report===null&&during.destination.libraryId===b.id&&during.destination.folderId===bFolder,"changing current by creating C and selecting save A while running keeps B task ownership");
 assert(await until("visible running card",()=>session.exec("const card=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!card&&card.getClientRects().length>0&&[...card.querySelectorAll('.k-task-sub')].some(n=>n.textContent.includes('放到 保存库 B / B 最终目录'));",[runningCard])),"formal progress visibly reports original B position after selecting A");
 assert(!await session.exec("return [...document.querySelectorAll('.k-task')].some(card=>card.textContent.includes('已导入，正在把标签定义存进图库'));"),"running task does not claim content completion before its actual report");
 assert(await session.invoke("cancel_import",{libraryId:a.id,taskId:long}).then(()=>false,()=>true),"wrong-owner cancellation is rejected during the real task");
 await session.screenshot("running-owner-after-current-and-target-change.png");
 const completed=await finish(long);receipts.push(completed);
 assert(!completed.report.cancelled&&completed.report.items.length===2000,"B task completes all 2000 entries after current/create/target changes");
 assert((await local(a.id)).total===0&&(await local(c.id)).total===0&&(await local(b.id,bFolder)).total===1,"completed content stays in B rather than new current or newly selected A");
 }
 const bCard=(await local(b.id,bFolder)).cards[0];
 await session.invoke("workspace_edit_source",{target:{libraryId:b.id,imageId:bCard.imageId,contentId:bCard.id},safeMode:true,edits:[{kind:"setNote",text:"B 原来源备注"}]});
 // Existing independent target curation survives explicit source copying.
 const cImport=await session.invoke("start_import",{libraryId:c.id,source:{paths:[imagePath]},destination:{libraryId:c.id,folderId:null}});await finish(cImport);
 const cCard=(await local(c.id)).cards.find(card=>card.id===bCard.id);
 const cTarget={libraryId:c.id,imageId:cCard.imageId,contentId:cCard.id};
 await session.invoke("workspace_edit_source",{target:cTarget,safeMode:true,edits:[{kind:"setNote",text:"C 独立人工备注"}]});
 await browseAll();
 // The card's source button is a sibling of its option; with two sources it reads “在 2 个图库 · 查看详情”.
 const sourcesButton=`//div[@role='listbox' and @aria-label='图片墙']//button[contains(@class,'card-sources') and @data-card='${bCard.id}' and starts-with(@aria-label,'在 2 个图库')]`;
 await until("aggregate source choices",()=>shown(sourcesButton));
 await readyClick(sourcesButton);
 await readyClick(`//*[@data-source-library-id='${b.id}']//button[normalize-space()='整理此来源']`);
 await readyClick("//button[normalize-space()='复制到…']");
 const copyDialog=dialogX("复制此来源");
 await choose(c.id,null,copyDialog);await session.screenshot("copy-explicit-confirmation.png");await readyClick(`${copyDialog}//button[normalize-space()='确认复制']`);
 await until("source copy finished",async()=>!await exists(copyDialog));
 const cAfter=await until("copy source facts saved",async()=>{const value=await session.invoke("workspace_source_inspection",{target:cTarget,safeMode:true,lang:"zh-CN"});return value.detail.note.sources.some(s=>s.source.includes(b.id))?value:null;});
 assert(cAfter.detail.note.sources.some(s=>s.source.includes(b.id)),"cross-library copy retains the original B provenance");
 assert(cAfter.detail.note.manual==="C 独立人工备注","formal cross-library copy preserves the existing target manual note");
 assert((await local(c.id)).total===1,"copy merges identical bytes without creating a public pool or a duplicate target image");
 await until("copy confirmation stays closed after refresh",async()=>!await exists(copyDialog));
 await delay(500);
 assert(!await exists(copyDialog),"copy confirmation stays closed after the real source refresh");
 await session.screenshot("copy-preserves-independent-curation.png");
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"passed",scope:process.argv.includes("--copy-only")?"copy-only":"visible-owner-and-copy",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,finishedAt:new Date().toISOString()},null,2));
 console.log(`Evidence: ${work}`);
}catch(error){
 console.error(error);if(session){await session.screenshot("failure.png").catch(()=>{});await session.exec("return document.documentElement.outerHTML;").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});}
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"failed",scope:process.argv.includes("--copy-only")?"copy-only":"visible-owner-and-copy",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,error:String(error)},null,2));process.exitCode=1;
}finally{
 await stopApp();if(driver.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});
}
