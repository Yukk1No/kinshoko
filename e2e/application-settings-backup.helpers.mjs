// application-settings-backup.mjs helpers: the old-schema fixture, the WebDriver client and the app lifecycle.
// `session` is a live binding; `boot` and `normalQuit` replace it.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { chunk } from "./lib/fixtures.mjs";

let application, edgeArg, work, libraries, oldSchema, port, driverUrl, sha, data, profile, driver;
export let session;
export function configure(values) { ({ application, edgeArg, work, libraries, oldSchema, port, driverUrl, sha } = values); }
export function useProfile(appData, webview) { data = appData; profile = webview; }
export function clearSession() { session = null; }

export const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(3,0);ihdr.writeUInt32BE(3,4);ihdr[8]=8;ihdr[9]=2;
// 例外（#521）：这张图的尺寸、颜色规则与 lib/fixtures.mjs 的 png 不同，合并会改变测试图的像素，所以留在本地。
export function png(red){const row=Buffer.from([0,red,28,38,red,28,38,red,28,38]);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(Buffer.concat([row,row,row]))),chunk("IEND",Buffer.alloc(0))]);}
export function oldLibrary(name,red,positive){const root=join(libraries,name);mkdirSync(root);const db=new DatabaseSync(join(root,"library.sqlite"));db.exec(oldSchema);const identity=value=>sha(name+value).slice(0,32),id=identity("library");db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id,name);const tags={},originals=[];
function tag(key,label){const local=identity(key);tags[key]=local;db.prepare("INSERT INTO tag VALUES (?,'general',1000)").run(local);db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(local,label);db.prepare("INSERT INTO tag_external VALUES (?,?)").run(key,local);return local;}
const blue=tag("blue_eyes","蓝瞳"),aqua=tag("aqua_eyes","水色瞳"),sky=tag("spec78_sky","天空色");
function add(key,color,tag){const bytes=png(color),hash=sha(bytes),rel=`originals/${hash.slice(0,2)}/${hash}.png`;mkdirSync(join(root,"originals",hash.slice(0,2)),{recursive:true});writeFileSync(join(root,rel),bytes);const imageId=identity(key);db.prepare("INSERT INTO image(id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at,rating_manual,note_manual) VALUES(?,?,?,'png',?,3,3,1,?,1000,'general',?)").run(imageId,hash,bytes.length,rel,key+".png","原有备注 "+name);db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId,tag);originals.push({imageId,path:join(root,rel),sha:hash});return imageId;}
add("blue",red,blue);add("aqua",red+10,aqua);add("sky",red+20,sky);db.prepare("INSERT INTO personal_approx VALUES (?,?,?,1000)").run(blue,aqua,positive?"similar":"notSimilar");const group=identity("group");db.prepare("INSERT INTO tag_group VALUES (?,?,'general',0,1000)").run(group,"旧组 "+name);db.prepare("INSERT INTO tag_group_member VALUES (?,?,0)").run(group,blue);db.close();return {info:{id,root,name},tags,originals};}
// 例外（#521）：wd、until、quitOwnApp 留在本地——driverUrl、application 要等 configure() 才有值，createDriver 需要创建时就拿到。
export { chunk };
export const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
export async function wd(method, path, body) {
  const response = await fetch(driverUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(label, read, timeout = 30000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const result = await read(); if (result) return result; } catch (reason) { error = reason; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
}
export const assertions = [];
export function assert(ok, label) { if (!ok) throw new Error(label); assertions.push(label); console.log(`PASS ${label}`); }
export class Session {
  static async start() {
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: profile } } } } });
    const session = new Session(result.sessionId);
    await until("Tauri IPC ready", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke((arguments[0].includes(':') || arguments[0].startsWith('shell_') || ['set_autostart','set_show_approx_source','set_force_srgb','set_usage_log','set_viewer_background','migrate_viewer_background'].includes(arguments[0]) || arguments[0].startsWith('rebind_') || arguments[0].startsWith('tagging_') || arguments[0].startsWith('clear_usage') || arguments[0].startsWith('diagnostics_') ? arguments[0] : 'plugin:library|' + arguments[0]), arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
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
export function quitOwnApp(){return spawnSync("powershell",["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T13_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],{env:{...process.env,KINSHOKO_T13_EXECUTABLE:application},windowsHide:true,stdio:"ignore"});}
export function stopDriver(){if(driver?.pid)spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});driver=null;}
export async function boot(fault){mkdirSync(data,{recursive:true});mkdirSync(profile,{recursive:true});driver=spawn(process.argv[4]??"tauri-driver",["--port",String(port),"--native-port",String(port+1),"--native-driver",resolve(edgeArg)],{env:{...process.env,APPDATA:join(work,"roaming"),LOCALAPPDATA:join(work,"local"),KINSHOKO_DATA_DIR:data,KINSHOKO_SKIP_AUTOSTART:"1",WEBVIEW2_USER_DATA_FOLDER:profile,...(fault?{KINSHOKO_FAULT:fault}: {})},windowsHide:true,stdio:["ignore","inherit","inherit"]});await until("driver ready",()=>fetch(driverUrl+"/status").then(r=>r.ok));session=await Session.start();await until("formal main controls",()=>session.find(setting));}
export const setting="//button[@aria-label='设置' or normalize-space()='设置']";
export async function normalQuit(label){const receipt=join(work,label+"-normal-quit.json");const result=spawnSync("python",["e2e/native-tray-exit-t13.py",application,receipt],{windowsHide:true,encoding:"utf8",timeout:45000});if(result.status!==0||!JSON.parse(readFileSync(receipt,"utf8")).processEnded)throw Error(`Normal tray exit failed: ${label} ${result.stderr}`);await session.close().catch(()=>{});session=null;}
export async function restart(label){await normalQuit(label);stopDriver();await boot();}
export async function openSettings(){if(!await session.exec("return Boolean(document.querySelector('[role=dialog][aria-label=程序设置]'))"))await session.click(setting);await until("settings section mounted",()=>session.find("//fieldset[@aria-label='程序设置备份']"));}
export async function closeSettings(){await session.click("//button[normalize-space()='关闭设置']");}
export const backupInput="//input[@aria-label='程序设置备份文件']";
export async function backup(path){await openSettings();await session.set(backupInput,path);await session.click("//button[normalize-space()='备份当前程序设置']");await until("backup saved",()=>session.exec("return document.querySelector('fieldset[aria-label=程序设置备份]').textContent.includes('程序设置备份完成。')"));}
export async function restore(path,label){await openSettings();await session.set(backupInput,path);assert(!await session.exec("return Boolean(document.querySelector('[role=group][aria-label=确认替换程序设置]'))"),"replacement requires reading the chosen package: "+label);await session.click("//button[normalize-space()='读取程序设置备份']");await until("replacement scope visible",()=>session.find("//div[@role='group' and @aria-label='确认替换程序设置']"));assert(await session.exec("return document.querySelector('[role=group][aria-label=确认替换程序设置]').textContent.includes('缺席的名称偏好和个人规则会删除')"),"formal scope explicitly replaces missing choices: "+label);await session.screenshot(label+"-confirmation.png");await session.click("//button[normalize-space()='替换程序设置']");await until("replacement finished",()=>session.exec("return document.querySelector('fieldset[aria-label=程序设置备份]').textContent.includes('程序设置恢复完成。')"));assert(!await session.exec("return Boolean(document.querySelector('fieldset[aria-label=程序设置备份] [role=alert]'))"),"replacement reports no runtime registration failures: "+label);}
export function ownedWindows(){const result=spawnSync("python",["e2e/native-process-observe-t13.py","windows",application],{windowsHide:true,encoding:"utf8"});if(result.status!==0)throw Error(result.stderr);return JSON.parse(result.stdout);}
export async function hotkey(key){const result=spawnSync("python",["e2e/native-process-observe-t13.py","hotkey",application,key],{windowsHide:true,encoding:"utf8",timeout:10000});if(result.status!==0)throw Error(result.stderr);const receipt=JSON.parse(result.stdout);writeFileSync(join(work,"native-hotkey-"+key+".json"),JSON.stringify(receipt,null,2));return receipt;}
