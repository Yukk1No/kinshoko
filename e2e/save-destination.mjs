// #78 T10: explicit save destinations and real running-task ownership in the formal application.
// Setup uses public Tauri actions; curation uses the rendered explicit-source controls.
// Usage: node e2e/save-destination.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/save-destination.mjs <owned kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `save-destination-${Date.now()}`);
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
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore" });
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
const setSelect=async(label,value)=>{
 await until("choice loaded "+label,()=>session.exec("return [...document.querySelectorAll('select')].some(s=>s.getAttribute('aria-label')===arguments[0]&&s.getClientRects().length>0&&[...s.options].some(o=>o.value===arguments[1]));",[label,value]));
 await session.exec("const s=[...document.querySelectorAll('select')].find(s=>s.getAttribute('aria-label')===arguments[0]&&s.getClientRects().length>0);s.value=arguments[1];s.dispatchEvent(new Event('change',{bubbles:true}));",[label,value]);
};
const openMenu=async()=>{
 if(!await session.exec("return document.querySelector('[aria-label=\"导入参考图\"]')?.getAttribute('aria-expanded')==='true';"))await session.click("//button[@aria-label='导入参考图']");
};
const choose=async(libraryId,folderId=null)=>{await setSelect("保存到资料库",libraryId);await setSelect("保存到文件夹",folderId??"");};
async function begin(paths,libraryId,folderId=null,eagle=false){
 const previous=new Set((await session.invoke("import_tasks")).map(t=>t.taskId));
 await openMenu();await choose(libraryId,folderId);
 await session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];",[paths]);
 await session.click("//button[normalize-space()='导入文件…']");
 await session.click(`//button[normalize-space()='${eagle?"开始 Eagle 导入":"开始导入"}']`);
 const receipt=await until("new owned import",async()=>(await session.invoke("import_tasks")).find(t=>!previous.has(t.taskId)));
 return receipt.taskId;
}
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
 await until("formal current A",()=>session.exec("return document.querySelector('[aria-label=\"当前资料库\"]')?.value===arguments[0];",[a.id]));
 await openMenu();
 assert(await session.exec("return document.querySelector('[aria-label=\"保存到资料库\"]').value==='';"),"global import begins with an explicit unchosen destination");
 const first=await begin([imagePath],b.id,bFolder);
 const firstReceipt=await finish(first);receipts.push(firstReceipt);
 assert(firstReceipt.destination.libraryId===b.id&&firstReceipt.destination.folderId===bFolder,"ordinary import receipt keeps the submitted library and folder");
 assert((await local(b.id,bFolder)).total===1&&(await local(a.id)).total===0,"ordinary file is committed into B folder while A remains empty");
 assert((await session.invoke("current_library")).id===a.id,"saving into B does not activate B or change browsing current A");
 await session.screenshot("explicit-import-destination.png");
 const long=await begin(Array(2000).fill(imagePath),b.id,bFolder);
 const before=await running(long);receipts.push({phase:"before-current-create-target-change",receipt:before});
 // The actual new-library page must preserve the running task while its current provider changes.
 if(!await session.exec("return document.querySelector('.library-tools')?.open;"))await session.click("//summary[normalize-space()='资料库操作']");
 await session.click("//button[normalize-space()='新建资料库…']");
 await session.type("//label[contains(.,'资料库名称')]/input","新浏览库 C");
 await session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];",[libraries]);
 await session.click("//button[normalize-space()='选择存放位置…']");
 await session.click("//button[normalize-space()='建立资料库']");
 c=await until("created current C",async()=>{const value=await session.invoke("current_library");return value?.name==="新浏览库 C"?value:null;});
 await openMenu();await choose(a.id,aFolder);
 await session.click("//button[normalize-space()='全部资料库']");
 const during=await task(long);receipts.push({phase:"after-current-create-target-change",receipt:during});
 assert(during.report===null&&during.destination.libraryId===b.id&&during.destination.folderId===bFolder,"changing current by creating C and selecting save A while running keeps B task ownership");
 assert(await session.exec("return document.querySelector('.import-owner')?.textContent.includes('保存库 B / B 最终目录');"),"formal progress visibly reports original B position after selecting A");
 assert(await session.invoke("cancel_import",{libraryId:a.id,taskId:long}).then(()=>false,()=>true),"wrong-owner cancellation is rejected during the real task");
 await session.screenshot("running-owner-after-current-and-target-change.png");
 const completed=await finish(long);receipts.push(completed);
 assert(!completed.report.cancelled&&completed.report.items.length===2000,"B task completes all 2000 entries after current/create/target changes");
 assert((await local(a.id)).total===0&&(await local(c.id)).total===0&&(await local(b.id,bFolder)).total===1,"completed content stays in B rather than new current or newly selected A");
 // Remove a real target folder while the selected task is visibly running.
 await session.invoke("switch_library",{libraryId:b.id});
 const vanished=await session.invoke("create_folder",{libraryId:b.id,name:"运行中失效目录",parent:null});
 await session.invoke("switch_library",{libraryId:c.id});
 const failing=await begin(Array(1200).fill(imagePath),b.id,vanished);
 const deletionPhase=await running(failing);
 const deletion=spawnSync("python",["-c","import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1],timeout=10); c.execute('DELETE FROM folder_member WHERE folder_id=?',(sys.argv[2],)); c.execute('DELETE FROM folder_decision WHERE folder_id=?',(sys.argv[2],)); c.execute('DELETE FROM folder WHERE id=?',(sys.argv[2],)); c.commit(); print(json.dumps({'externalFolderRemoved':sys.argv[2]}))",join(b.root,"library.sqlite"),vanished],{windowsHide:true,encoding:"utf8"});
 if(deletion.status!==0)throw new Error(deletion.stderr);
 await choose(a.id,aFolder);
 const failed=await finish(failing);receipts.push({phase:"external-folder-loss-while-running",before:deletionPhase,operation:JSON.parse(deletion.stdout),after:failed});
 const successful=failed.report.items.filter(item=>["imported","merged","eagleRefreshed","newVersion"].includes(item.outcome.kind));
 const rejected=failed.report.items.filter(item=>item.outcome.kind==="readFailed");
 assert(successful.length>0&&rejected.length>0&&failed.report.items.length===1200,"running target loss reports completed and failed items instead of a whole-batch success");
 assert(rejected.every(item=>/保存目标不可用|没有这个文件夹/.test(item.outcome.reason)),"remaining failures name the actual unavailable destination");
 assert((await local(a.id)).total===0&&(await local(c.id)).total===0,"failed target does not fall back into the newly chosen or current library");
 await session.screenshot("actual-partial-import-result.png");
 // Eagle uses the same destination and retains its provider folders.
 const eagleRoot=join(work,"eagle.library");mkdirSync(join(eagleRoot,"images","ITEM1.info"),{recursive:true});
 writeFileSync(join(eagleRoot,"images","ITEM1.info","eagle.png"),readFileSync(imagePath));
 writeFileSync(join(eagleRoot,"images","ITEM1.info","metadata.json"),JSON.stringify({id:"ITEM1",name:"eagle",ext:"png",width,height,size:readFileSync(imagePath).length,tags:["T10 Eagle"],folders:["SOURCE"],annotation:"原 Eagle 来源",url:"https://example.com/t10",isDeleted:false,btime:1,mtime:2,modificationTime:3}));
 writeFileSync(join(eagleRoot,"metadata.json"),JSON.stringify({applicationVersion:"4.0.0",folders:[{id:"SOURCE",name:"Eagle 原目录",children:[]}]}));
 const eagleTask=await begin([eagleRoot],b.id,bFolder,true);const eagleReceipt=await finish(eagleTask);receipts.push(eagleReceipt);
 assert(eagleReceipt.report.fromEagle&&eagleReceipt.report.items[0].outcome.kind!=="readFailed"&&eagleReceipt.destination.folderId===bFolder,"real Eagle entry uses the chosen final folder");
 const bCard=(await local(b.id,bFolder)).cards[0];
 const target={libraryId:b.id,imageId:bCard.imageId,contentId:bCard.id};
 const sourceGroup=await session.invoke("workspace_source_group",{target,safeMode:true,name:"T10 原来源包",groupId:null});
 const packagePath=join(work,"source.kinshoko-group");
 await session.desktop("export_reference_group_package",{groupId:sourceGroup.id,path:packagePath});
 await session.click("//button[@aria-label='参考组']");
 await session.click("//button[normalize-space()='导入参考组包']");
 await choose(a.id,aFolder);await session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];",[packagePath]);
 await session.click("//button[normalize-space()='选择参考组包并导入']");
 await until("package saved to A",async()=>(await local(a.id,aFolder)).total===1);
 assert((await session.invoke("current_library")).id===c.id,"formal package import into A keeps current C");
 await session.screenshot("package-explicit-destination.png");
 // The real clipboard entry creates capture history. Collection then uses the shared dialog.
 const copied=spawnSync("powershell",["-NoProfile","-NonInteractive","-STA","-Command","Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $t10Image=[System.Drawing.Image]::FromFile($env:KINSHOKO_T10_CLIPBOARD); [System.Windows.Forms.Clipboard]::SetImage($t10Image); $t10Image.Dispose()"],{env:{...process.env,KINSHOKO_T10_CLIPBOARD:imagePath},windowsHide:true,encoding:"utf8"});
 if(copied.status!==0)throw new Error(copied.stderr);
 await session.desktop("pin_clipboard");
 // Move the genuine always-on-top capture pin away from the controls under test.
 const nativeWindows=await wd("POST",`${session.base}/execute/async`,{script:"const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows').then(done);",args:[]});
 for(const label of nativeWindows)if(label.startsWith("pin-"))await session.desktop("move_pin",{pin:label.slice(4),x:1400,y:800});
 const capture=(await session.desktop("capture_history"))[0];
 await session.click("//button[@aria-label='截图历史']");
 await session.click("//*[contains(@class,'capture-history')]//button[normalize-space()='收藏…']");
 await choose(b.id,bFolder);await session.click("//*[@aria-label='收藏截图']//button[normalize-space()='确认保存']");
 const collected=await until("actual collected capture",async()=>{const entry=(await session.desktop("capture_history")).find(e=>e.id===capture.id);return entry?.collected.find(c=>c.libraryId===b.id);});
 const captureSha=createHash("sha256").update(readFileSync(join(appData,"captures",capture.id+".png"))).digest("hex");
 assert((await local(b.id,bFolder)).cards.some(card=>card.id===captureSha&&card.imageId===collected.imageId),"screenshot collection preserves the capture bytes in the chosen B folder");
 await session.screenshot("capture-explicit-destination.png");
 // Existing independent target curation survives explicit source copying.
 const cImport=await session.invoke("start_import",{libraryId:c.id,source:{paths:[imagePath]},destination:{libraryId:c.id,folderId:null}});await finish(cImport);
 const cCard=(await local(c.id)).cards.find(card=>card.id===bCard.id);
 const cTarget={libraryId:c.id,imageId:cCard.imageId,contentId:cCard.id};
 await session.invoke("workspace_edit_source",{target:cTarget,safeMode:true,edits:[{kind:"setNote",text:"C 独立人工备注"}]});
 await session.click("//button[@aria-label='图片与文件夹']").catch(()=>{});
 await session.click("//button[normalize-space()='全部资料库']");
 await until("aggregate source choices",()=>session.find("//*[@data-id]//button[contains(.,'份来源')]"));
 await session.click("//*[@data-id]//button[contains(.,'份来源')]");
 await session.click(`//*[@data-source-library-id='${b.id}']//button[normalize-space()='整理此来源']`);
 await session.click("//button[normalize-space()='复制到资料库…']");
 await choose(c.id,null);await session.click("//*[@aria-label='复制此来源']//button[normalize-space()='确认复制']");
 await until("source copy finished",()=>session.exec("return !document.querySelector('[aria-label=\"复制此来源\"]');"));
 const cAfter=await session.invoke("workspace_source_inspection",{target:cTarget,safeMode:true,lang:"zh-CN"});
 assert(cAfter.detail.note.manual==="C 独立人工备注","formal cross-library copy preserves the existing target manual note");
 assert((await local(c.id)).total===1,"copy merges identical bytes without creating a public pool or a duplicate target image");
 await session.screenshot("copy-preserves-independent-curation.png");
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"passed",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,finishedAt:new Date().toISOString()},null,2));
 console.log(`Evidence: ${work}`);
}catch(error){
 console.error(error);if(session){await session.screenshot("failure.png").catch(()=>{});await session.exec("return document.documentElement.outerHTML;").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});}
 writeFileSync(join(work,"result.json"),JSON.stringify({status:"failed",source,binarySha256,application,environment,provenance,a,b,c,receipts,assertions,error:String(error)},null,2));process.exitCode=1;
}finally{
 await stopApp();if(driver.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});
}
