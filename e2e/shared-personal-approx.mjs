// #78 T06: shared personal rules, explicit conflict decisions, once/forever/plus and restart.
// Fixture creation uses the released v16 schema. All rule actions/readback use public IPC or rendered controls.
// Usage: node e2e/shared-personal-approx.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/shared-personal-approx.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const sourceManifest = JSON.parse(readFileSync("work/t06/native-source.json", "utf8"));
const source = sourceManifest.commit;
const harnessSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
if (binarySha256.toLowerCase() !== sourceManifest.binarySha256.toLowerCase()) throw new Error("Native binary does not match its source manifest");
const work = resolve("work", "e2e", `shared-approx-${Date.now()}`);
mkdirSync(work, { recursive: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
mkdirSync(join(work, "roaming")); mkdirSync(join(work, "local"));
const imagePath = join(work, "image.png");
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
const row = Buffer.from([0, 18, 28, 38, 18, 28, 38, 18, 28, 38]);
writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]));
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4474);
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
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
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
  async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
  async click(xpath) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
      catch (error) {
        if (attempt >= 4 || !/stale element reference|no such element/.test(error.message)) throw error;
        await delay(150);
      }
    }
  }
  async set(xpath, value) {
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!element) throw Error('control missing'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, arguments[1]); element.dispatchEvent(new Event('input', { bubbles: true }));", [xpath, value]);
  }
  async select(xpath, value) {
    await until("enabled select option", () => this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return element && !element.disabled && [...element.options].some((option) => option.value === arguments[1]);", [xpath, value]));
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; element.value = arguments[1]; element.dispatchEvent(new Event('change', { bubbles: true }));", [xpath, value]);
  }
  key(value) { return wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }] }); }
  async controlClick(xpath) {
    await wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: String.fromCharCode(0xE009) }] }] });
    try { await this.click(xpath); } finally { await wd("DELETE", `${this.base}/actions`); }
  }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, windowsHide: true, stdio: "ignore" });
}
const driver = spawn(process.argv[4] ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let session;
const setting = "//button[@aria-label='设置' or normalize-space()='设置']";

const oldSchema=readFileSync("crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql","utf8");
const oldSchemaSha256=createHash("sha256").update(oldSchema).digest("hex");
function png(red) { const row=Buffer.from([0,red,28,38,red,28,38,red,28,38]);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(Buffer.concat([row,row,row]))),chunk("IEND",Buffer.alloc(0))]); }
function oldLibrary(name,red,positive) {
  const root=join(libraries,name);mkdirSync(root);const db=new DatabaseSync(join(root,"library.sqlite"));db.exec(oldSchema);
  const identity=value=>createHash("sha256").update(name+value).digest("hex").slice(0,32),id=identity("library");db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id,name);
  const tags={},originals=[];
  function tag(key,label,external=key) {const local=identity(key);tags[key]=local;db.prepare("INSERT INTO tag VALUES (?,'general',1000)").run(local);db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(local,label);if(external)db.prepare("INSERT INTO tag_external VALUES (?,?)").run(external,local);return local;}
  const blue=tag("blue_eyes","蓝瞳"),aqua=tag("aqua_eyes","水色瞳"),secret=tag("spec78_secret","封印专用词");
  function add(key,color,tag,adult=false) {const bytes=png(color),sha=createHash("sha256").update(bytes).digest("hex"),rel=`originals/${sha.slice(0,2)}/${sha}.png`;mkdirSync(join(root,"originals",sha.slice(0,2)),{recursive:true});writeFileSync(join(root,rel),bytes);const imageId=identity(key);db.prepare("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at,rating_manual) VALUES (?,?,?,'png',?,3,3,1,?,1000,?)").run(imageId,sha,bytes.length,rel,key+".png",adult?"explicit":null);db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId,tag);originals.push({imageId,path:join(root,rel),sha});return imageId;}
  add("blue",red,blue);add("aqua",red+10,aqua);add("secret",99,secret,positive);
  if(!positive)add("sky",50,tag("sky","天空色",null));
  db.prepare("INSERT INTO personal_approx VALUES (?,?,?,1000)").run(blue,aqua,positive?"similar":"notSimilar");
  if(positive)db.prepare("INSERT INTO personal_approx VALUES (?,?,'similar',1001)").run(blue,secret);
  db.close();return {info:{id,root,name},tags,originals};
}
const first=oldLibrary("旧判断 A",10,true),second=oldLibrary("旧判断 B",30,false);
async function readRules(safe=true){return session.invoke("shared_personal_approx",{lang:"zh-CN",safeMode:safe});}
async function openSettings(){if(!await session.exec("return Boolean(document.querySelector('[role=dialog][aria-label=程序设置]'))"))await session.click(setting);await until("loaded global rule settings",()=>session.exec("const pane=document.querySelector('section[aria-label=全局个人近似规则]');return pane&&!pane.querySelector('[role=status]')"));await session.exec("document.querySelector('section[aria-label=全局个人近似规则]').scrollIntoView({block:'center'})");}
async function closeSettings(){await session.click("//button[normalize-space()='关闭设置']");}
async function uiTotal(total){await until(`wall total ${total}`,()=>session.exec("return Number(document.querySelector('.wall')?.dataset.total)===arguments[0]",[total]));}
async function clearSearch(){while(await session.exec("return document.querySelectorAll('.search-chip').length"))await session.click("//button[@aria-label='去掉这个条件']");}
async function pickBlue(){await clearSearch();await session.set("//input[@aria-label='查找参考图']","蓝瞳");await until("blue candidate",()=>session.find("//ul[@id='search-candidates']//li[@role='option' and contains(.,'蓝瞳')][not(contains(.,'查找'))]"));await session.click("//ul[@id='search-candidates']//li[@role='option' and contains(.,'蓝瞳')][not(contains(.,'查找'))]");}
async function normalQuit(label){const receipt=join(work,`${label}-normal-quit.json`);const quit=spawnSync("python",["e2e/native-tray-exit-t06.py",application,receipt],{windowsHide:true,encoding:"utf8",timeout:45000});if(quit.status!==0||!JSON.parse(readFileSync(receipt,"utf8")).processEnded)throw new Error(`Normal Quit failed (${label}): ${quit.stderr}`);await session.close().catch(()=>{});session=null;}
async function restart(label){await normalQuit(label);session=await Session.start();await until("main controls restored",()=>session.find(setting));}
try {
  await until("driver ready",()=>fetch(`${driverUrl}/status`).then(r=>r.ok));session=await Session.start();await session.invoke("set_safe_mode",{on:true});
  for(const library of [first,second]){const info=await session.invoke("register_library",{root:library.info.root});assert(info.id===library.info.id,`released v16 ${info.name} opens with stable identity`);}
  // Public IPC enrolls fixtures; normal restart loads the formal active-provider state.
  await restart("initial-enrollment");
  const webviewEnvironment=await session.exec("return {userAgent:navigator.userAgent,innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height};");
  await until("initial workspace inventory",()=>session.invoke("workspace_status",{safeMode:true}));await uiTotal(5);
  let view=await readRules();assert(view.conflicts.length===1&&view.entries.length===0,"opposite old rules remain pending rather than becoming a saved NotSimilar");assert(view.conflicts[0].sources.length===2&&view.conflicts[0].sources.some(s=>s.libraryName===first.info.name)&&view.conflicts[0].sources.some(s=>s.libraryName===second.info.name),"conflict retains both named provider origins");assert(!JSON.stringify(view).includes("封印专用词"),"global rule settings hide a label vetoed by another byte-identical Adult source");
  await openSettings();assert(await session.exec("return document.querySelector('section[aria-label=全局个人近似规则]').textContent.includes('尚未保存为“不相近”')"),"formal settings distinguish pending conflict from saved rejection");await session.screenshot("pending-two-provider-conflict.png");
  await session.click("//div[@role='group' and @aria-label='个人近似规则冲突']//button[normalize-space()='相近']");await until("explicit similar choice",async()=>{const value=await readRules();return value.conflicts.length===0&&value.entries.some(e=>e.relation==="similar");});assert(await session.invoke("safe_mode")===true,"conflict choice preserves global safe mode");await closeSettings();
  await pickBlue();await uiTotal(4);assert(await session.exec("return document.querySelector('.search-chips').textContent.includes('水色瞳')&&!document.querySelector('.search-chips').textContent.includes('个人')"),"formal search visibly expands the saved pair with source marks off by default");await session.screenshot("shared-similar-visible-search.png");
  await session.click("//button[@aria-label='不展开“水色瞳”']");await session.click("//button[normalize-space()='只这次']");await uiTotal(2);assert((await readRules()).entries.some(e=>e.relation==="similar"),"once changes the current lookup without removing the saved Similar rule");await pickBlue();await uiTotal(4);assert(true,"new lookup restores a once-dismissed expansion");
  await session.click("//button[@aria-label='不展开“水色瞳”']");await session.click("//button[normalize-space()='以后都不展开']");await until("saved global rejection",async()=>{const value=await readRules();return value.entries.some(e=>e.relation==="notSimilar");});await uiTotal(2);assert(true,"forever records a global NotSimilar and defeats the built-in pair");
  await session.click("//button[@aria-label='给“蓝瞳”加相近标签']");await session.set("//input[@aria-label='挑一个统一标签']","天空");await until("unmapped sky candidate",()=>session.find("//div[@role='dialog' and @aria-label='加相近标签']//li[@role='option' and contains(.,'天空色')]"));await session.click("//div[@role='dialog' and @aria-label='加相近标签']//li[@role='option' and contains(.,'天空色')]");await uiTotal(3);view=await readRules();assert(view.entries.some(e=>e.relation==="similar"&&(e.a.name==="天空色"||e.b.name==="天空色")&&(!e.a.hasExternal||!e.b.hasExternal)),"plus saves a visible tag without external correspondence");await session.screenshot("plus-unmapped-shared-rule.png");
  const blue=(await session.invoke("workspace_candidates",{text:"蓝瞳",lang:"zh-CN",limit:8,safeMode:true}))[0].tag.id;
  const conditions=await session.invoke("workspace_resolve",{input:{conditions:[{any:[{kind:"tag",id:blue,dismissed:[]}],negate:false}],exact:false},lang:"zh-CN",safeMode:true});
  for(const [library,total] of [[first,1],[second,2]]) {const page=await session.invoke("workspace_browse",{query:{scope:{kind:"library",libraryId:library.info.id,scope:{kind:"all"}},conditions,cursor:null,limit:20,thumbnailPx:128},safeMode:true});assert(page.total===total,`${library.info.name} applies shared rules through its distinct local IDs`);}
  await session.select("//select[@aria-label='当前资料库']",first.info.id);await until("current provider A",async()=>{try{return (await session.invoke("current_library"))?.id===first.info.id;}catch{return false;}});await pickBlue();await uiTotal(3);assert((await readRules()).entries.length===2,"switching the active library keeps the same application judgments");
  await session.click("//button[normalize-space()='精确查找']");await uiTotal(2);assert(true,"exact search suppresses the visible personal expansion");await session.click("//button[normalize-space()='精确查找']");await uiTotal(3);
  await session.click("//button[@aria-label='排除这个条件']");await uiTotal(2);assert(true,"exclusion keeps the same expanded condition semantics");await session.click("//button[@aria-label='不再排除这个条件']");await uiTotal(3);
  await openSettings();await session.click("//table[@aria-label='个人近似对应表']//tr[contains(.,'天空色')]//button[normalize-space()='删除']");await until("plus rule deleted",async()=>!(await readRules()).entries.some(e=>e.a.name==="天空色"||e.b.name==="天空色"));await closeSettings();await uiTotal(2);await restart("after-rule-edits");view=await readRules();assert(view.entries.length===1&&view.entries[0].relation==="notSimilar"&&view.conflicts.length===0,"normal restart retains rejection and removed plus rule without reintroducing legacy conflict");
  await session.invoke("set_safe_mode",{on:false});await until("unsafe view available",async()=>(await readRules(false)).entries.some(e=>e.a.name==="封印专用词"||e.b.name==="封印专用词"));assert((await readRules(false)).entries.length===2,"safe projection did not delete the complete hidden personal definition");await session.invoke("set_safe_mode",{on:true});await openSettings();assert(!await session.exec("return document.querySelector('section[aria-label=全局个人近似规则]').textContent.includes('封印专用词')"),"returning to safe mode revokes hidden rule labels in formal settings");await closeSettings();
  await normalQuit("before-offline-active");const offline=first.info.root+".offline";renameSync(first.info.root,offline);
  try {session=await Session.start();await until("workspace with no active provider",()=>session.find(setting));await until("empty active picker",()=>session.exec("const node=document.querySelector('select[aria-label=当前资料库]');return node&&!node.disabled&&node.value==='';"));await openSettings();view=await readRules();assert(view.entries.length===1&&view.entries[0].relation==="notSimilar","application settings remain manageable without an active provider");await session.screenshot("no-active-provider-rule-settings.png");await session.click("//table[@aria-label='个人近似对应表']//button[normalize-space()='删除']");await until("migrated rejection removed",async()=>(await readRules()).entries.length===0);await closeSettings();await restart("after-no-active-delete");view=await readRules();assert(view.entries.length===0&&view.conflicts.length===0,"deleting a migrated rule stays deleted across restart while the legacy provider still exists");await pickBlue();await uiTotal(2);assert(true,"deleting a personal rejection restores the built-in pair in the remaining provider");await normalQuit("finished");}
  finally {if(session){await session.close().catch(()=>{});session=null;quitOwnApp();}renameSync(offline,first.info.root);}
  for(const library of [first,second])for(const original of library.originals)assert(createHash("sha256").update(readFileSync(original.path)).digest("hex")===original.sha,`${library.info.name} original ${original.imageId} unchanged`);
  writeFileSync(join(work,"result.json"),JSON.stringify({status:"passed",source,harnessSource,binarySha256,application,stories:[30,31,32],oldSchemaSha256,webviewEnvironment,assertions,first,second},null,2));console.log(`Evidence: ${work}`);
} catch(error) {
  console.error(error);if(session){await session.screenshot("failure.png").catch(()=>{});await session.exec("return document.body.outerHTML").then(html=>writeFileSync(join(work,"failure.html"),html)).catch(()=>{});}writeFileSync(join(work,"result.json"),JSON.stringify({status:"failed",source,harnessSource,binarySha256,application,assertions,error:String(error)},null,2));process.exitCode=1;
} finally {if(session)await session.close().catch(()=>{});quitOwnApp();if(driver.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});}
