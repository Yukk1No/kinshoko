// Shared by save-destination.mjs and save-destination-followup.mjs: fixture image, WebDriver client
// and the formal-UI steps. Both runs restart the app, so the UI steps read `app.session` on every call.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export function writeTestPng(imagePath) {
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
  return { width, height };
}

export function driverClient({ driverUrl, application, work }) {
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
  return { ELEMENT, wd, delay, until, assertions, assert, Session };
}

export function importUi(app, { until }) {
  const query={scope:{kind:"all"},conditions:{conditions:[]},cursor:null,limit:100,thumbnailPx:128};
  const local=(libraryId,folderId=null)=>app.session.invoke("workspace_browse",{query:{...query,scope:{kind:"library",libraryId,scope:folderId?{kind:"folder",id:folderId}:{kind:"all"}}},safeMode:true});
  const task=async id=>(await app.session.invoke("import_tasks")).find(t=>t.taskId===id);
  const finish=id=>until("real completed receipt "+id,async()=>{const t=await task(id);return t?.report&&!t.finishing?t:null;},90000);
  // #388: the 导入 button opens a popover — sources on top (图片 / 文件夹 / 从 Eagle 导入), tasks below; a dialog
  // then chooses 图库 and 文件夹 (named by their visible labels); the current library is the sidebar
  // title menu; the browse scope is the 查找范围 nav. Steps use roles and accessible names.
  const lit=value=>value.includes("'")?`concat('${value.split("'").join(`',"'",'`)}')`:`'${value}'`;
  const dialogX=name=>`//*[@role='dialog' and (@aria-label=${lit(name)} or @aria-labelledby=//*[normalize-space()=${lit(name)}]/@id)]`;
  const importDialog=dialogX("导入图片"),eagleDialog=dialogX("从 Eagle 导入");
  const libraryChoice=prefix=>`${prefix}//label[span[@class='k-field-label' and contains(normalize-space(),'图库')]]//select`;
  const folderChoice=prefix=>`${prefix}//label[span[@class='k-field-label' and normalize-space()='文件夹']]//select`;
  const shown=xpath=>app.session.exec("const n=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!n&&n.getClientRects().length>0&&!n.disabled;",[xpath]);
  const setSelect=async(xpath,value)=>{
   await until("choice loaded "+xpath,()=>app.session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return !!s&&s.getClientRects().length>0&&!s.disabled&&[...s.options].some(o=>o.value===arguments[1]&&!o.disabled);",[xpath,value]));
   await app.session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;s.value=arguments[1];s.dispatchEvent(new Event('change',{bubbles:true}));",[xpath,value]);
   await until("choice applied "+xpath,()=>app.session.exec("const s=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return s?.value===arguments[1];",[xpath,value]));
  };
  const choose=async(libraryId,folderId=null,prefix=importDialog)=>{await setSelect(libraryChoice(prefix),libraryId);await setSelect(folderChoice(prefix),folderId??"");};
  const pick=value=>app.session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];",[value]);
  const readyClick=async xpath=>{await until("enabled "+xpath,()=>shown(xpath));await app.session.click(xpath);};
  // Opening the import dialog by picking files first; the dialog then asks where to save.
  const importPanel="//*[@role='dialog' and @aria-label='导入']";
  const source=label=>`${importPanel}//*[@aria-label='导入来源']//button[starts-with(normalize-space(),${lit(label)})]`;
  // Opens the import popover (its trigger reads 正在导入 while a task runs) unless it is already open.
  const openTasks=async()=>{if(!await exists(importPanel))await readyClick("//button[@aria-label='导入' or @aria-label='正在导入']");await until("import panel",()=>shown(importPanel));};
  const openImport=async paths=>{await pick(paths);await openTasks();await readyClick(source("图片"));await until("import dialog",()=>shown(libraryChoice(importDialog)));};
  async function startOpened(libraryId,folderId=null,prefix=importDialog){
   const previous=new Set((await app.session.invoke("import_tasks")).map(t=>t.taskId));
   await choose(libraryId,folderId,prefix);
   await readyClick(`${prefix}//button[normalize-space()='开始导入']`);
   const receipt=await until("new owned import",async()=>(await app.session.invoke("import_tasks")).find(t=>!previous.has(t.taskId)));
   return receipt.taskId;
  }
  async function begin(paths,libraryId,folderId=null,eagle=false){
   if(eagle){await pick(paths[0]);await openTasks();await readyClick(source("文件夹"));await until("Eagle import dialog",()=>shown(libraryChoice(eagleDialog)));return startOpened(libraryId,folderId,eagleDialog);}
   await openImport(paths);return startOpened(libraryId,folderId);
  }
  const exists=xpath=>app.session.exec("return !!document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;",[xpath]);
  // While an import runs the import button is disabled by design; the next save target is chosen in another
  // save-destination dialog (导入参考组包), then that dialog is cancelled without saving anything.
  const chooseNextTarget=async(libraryId,folderId=null)=>{
   await openPane("参考组");await readyClick("//button[normalize-space()='导入参考组包']");
   const dialog=dialogX("导入参考组包");await choose(libraryId,folderId,dialog);
   await readyClick(`${dialog}//button[normalize-space()='取消']`);await until("package dialog closed",async()=>!await shown(dialog));
   await openPane("图片与文件夹");
  };
  const openPane=async name=>{if(await app.session.exec("return document.querySelector('nav[aria-label=主导航] button[aria-label=\"'+arguments[0]+'\"]')?.getAttribute('aria-expanded')!=='true';",[name]))await readyClick(`//nav[@aria-label='主导航']//button[@aria-label=${lit(name)}]`);await until("pane open "+name,()=>app.session.exec("return document.querySelector('nav[aria-label=主导航] button[aria-label=\"'+arguments[0]+'\"]')?.getAttribute('aria-expanded')==='true';",[name]));};
  // #113 (ADR-0008): no current-library control; the library shows as a connected sidebar group head “名称（N 张）”.
  const shownCurrentName=name=>app.session.exec("return [...document.querySelectorAll('nav[aria-label=查找范围] [data-library-id] .lib-head-name')].some(b=>!b.disabled&&b.getAttribute('aria-label')?.startsWith(arguments[0]+'（')&&/（\\d+ 张）$/.test(b.getAttribute('aria-label')));",[name]);
  const browseAll=async()=>{await openPane("图片与文件夹");const xpath="//nav[@aria-label='查找范围']//button[normalize-space()='全部图片']";await readyClick(xpath);await until("all images scope",()=>app.session.exec("const n=document.evaluate(arguments[0],document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;return n?.getAttribute('aria-current')==='page';",[xpath]));};
  const runningCard=`${importPanel}//*[@role='group' and @aria-label='导入进度']`;
  const createLibraryFromMenu=async(name,parent)=>{
   await readyClick("//button[@aria-label='打开、新建或管理图库']");
   await readyClick("//*[@role='menu' and @aria-label='图库']//*[@role='menuitem' and normalize-space()='新建图库…']");
   await app.session.type("//label[contains(.,'图库名称')]/input",name);
   await pick(parent);
   await readyClick("//button[normalize-space()='选择存放位置…']");
   await readyClick("//button[normalize-space()='建立图库']");
  };
  return { query, local, task, finish, lit, dialogX, importDialog, libraryChoice, folderChoice, shown, setSelect, choose, pick, readyClick, openImport, startOpened, begin, exists, chooseNextTarget, openPane, shownCurrentName, browseAll, runningCard, openTasks, createLibraryFromMenu, eagleDialog };
}
