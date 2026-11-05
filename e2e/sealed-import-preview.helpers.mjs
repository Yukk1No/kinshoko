// sealed-import-preview.mjs helpers: the WebDriver client, the webview side of a receipt read and starting an import.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function driverClient({ url, application, work, result }) {
  async function until(label, read, timeout = 30000) { let error; for (const end = Date.now() + timeout; Date.now() < end; await delay(150)) { try { const value = await read(); if (value) return value; } catch (reason) { error = reason; } } throw Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`); }
  async function wd(method, path, body) { const response = await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); if (!response.ok || data.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(data.value)}`); return data.value; }
  // Serialised into the real webview; this is the same public Channel protocol as src/ipc.ts.
  function receiptRead(args, onFirstChunk, actionReturnedAt) {
    return new Promise(resolve => {
      const ipc = window.__TAURI_INTERNALS__, startedAt = performance.now();
      let length = 0, chunks = 0, maximumChunkBytes = 0, firstChunkAt = null, lastChunkAt = null, completionMarkerAt = null, channelEndedAt = null, acknowledgedAt = null, rejectedAt = null, chunksAfterActionResponse = 0, bytesAfterActionResponse = 0, acknowledged = false, failure = null, settled = false;
      const stats = () => ({ length, chunks, maximumChunkBytes, startedAt, firstChunkAt, lastChunkAt, completionMarkerAt, channelEndedAt, acknowledgedAt, rejectedAt, chunksAfterActionResponse, bytesAfterActionResponse, endedAt: performance.now(), elapsedMs: performance.now() - startedAt });
      const finish = () => {
        if (settled || channelEndedAt === null) return;
        if (failure !== null) { settled = true; resolve({ ...stats(), failure }); }
        else if (completionMarkerAt !== null && acknowledged) { settled = true; resolve(stats()); }
      };
      const callback = ipc.transformCallback(raw => {
        if (raw.end) { channelEndedAt = performance.now(); ipc.unregisterCallback(callback); finish(); return; }
        const count = raw.message.byteLength ?? raw.message.length;
        if (count === 0) completionMarkerAt = performance.now();
        else {
          length += count; chunks++; maximumChunkBytes = Math.max(maximumChunkBytes, count); lastChunkAt = performance.now();
          if (actionReturnedAt?.() != null) { chunksAfterActionResponse++; bytesAfterActionResponse += count; }
          if (firstChunkAt === null) { firstChunkAt = lastChunkAt; onFirstChunk?.(); }
        }
        finish();
      });
      ipc.invoke('plugin:library|read_import_preview', { ...args, onChunk: '__CHANNEL__:' + callback }).then(() => { acknowledged = true; acknowledgedAt = performance.now(); finish(); }, error => { rejectedAt = performance.now(); failure = String(error); finish(); });
    });
  }
  const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
  class Session {
    constructor(id) { this.base = `/session/${id}`; }
    static async start() { const value = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } }); const session = new Session(value.sessionId); await until("main IPC", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);")); return session; }
    exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
    async invoke(command, args = {}, plugin = "library") { const value = await wd("POST", `${this.base}/execute/async`, { script: "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({failure:String(error)}));", args: [plugin ? `plugin:${plugin}|${command}` : command, args] }); if (value.failure) throw Error(`${command}: ${value.failure}`); return value.value; }
    async click(xpath) { return until("click " + xpath, async () => { const id = (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; await wd("POST", `${this.base}/element/${id}/click`, {}); return true; }); }
    selectCss(css, value) { return this.exec("const e=[...document.querySelectorAll(arguments[0])].find(e=>e.getClientRects().length);if(!e)throw Error('select missing');e.value=arguments[1];e.dispatchEvent(new Event('change',{bubbles:true}));", [css, value]); }
    select(label, value) { return this.exec("const e=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===arguments[0]&&e.getClientRects().length);if(!e)throw Error('select missing');e.value=arguments[1];e.dispatchEvent(new Event('change',{bubbles:true}));", [label, value]); }
    async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
    close() { return wd("DELETE", this.base); }
    async bytes(sessionId, itemId, targetPx = 640) { const value = await wd("POST", `${this.base}/execute/async`, { script: `const done=arguments[arguments.length-1];(${receiptRead})(arguments[0]).then(done);`, args: [{ sessionId, itemId, targetPx }] }); result.transfers.push({ sessionId, itemId, targetPx, ...value }); return value; }
    async readRace(preview, action, afterFirstChunk = false, targetPx = 319) {
      const value = await wd("POST", `${this.base}/execute/async`, { script: `const done=arguments[arguments.length-1],args=arguments[0],action=arguments[1],afterFirst=arguments[2],readPreview=${receiptRead};let ended=false,actionPromise,actionStartedAt,pendingAtAction,actionReturnedAt=null;const act=()=>{if(actionPromise)return;pendingAtAction=!ended;actionStartedAt=performance.now();actionPromise=window.__TAURI_INTERNALS__.invoke(action.command,action.args).then(value=>{actionReturnedAt=performance.now();return {value,actionEndedAt:actionReturnedAt};},error=>{actionReturnedAt=performance.now();return {actionFailure:String(error),actionEndedAt:actionReturnedAt};});};const read=readPreview(args,afterFirst?act:undefined,()=>actionReturnedAt).then(value=>{ended=true;return value;});if(!afterFirst)Promise.resolve().then(act);read.then(async value=>{if(!actionPromise)act();done({...value,pendingAtAction,actionStartedAt,...await actionPromise});});`, args: [{ sessionId: preview.id, itemId: preview.items[0], targetPx }, action, afterFirstChunk] });
      const race = { action, afterFirstChunk, targetPx, ...value, actionElapsedMs: value.actionEndedAt - value.actionStartedAt };
      result.races.push(race); return race;
    }
  }
  async function openMenu(session) { if (!await session.exec("return document.querySelector('[aria-label=导入参考图]')?.getAttribute('aria-expanded')==='true';")) await session.click("//button[@aria-label='导入参考图']"); }
  async function begin(session, targetId, paths) { const previous = new Set((await session.invoke("import_tasks")).map(t => t.taskId)); await openMenu(session); await until("destination choices", () => session.exec("return [...document.querySelectorAll('.k-destination-grid > label:nth-of-type(1) select option')].some(o=>o.value===arguments[0]);", [targetId])); await session.selectCss(".k-destination-grid > label:nth-of-type(1) select", targetId); await session.selectCss(".k-destination-grid > label:nth-of-type(2) select", ""); await session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];", [paths]); await session.click("//button[normalize-space()='导入文件…']"); await session.click("//button[normalize-space()='开始导入']"); return until("fixed receipt owner", async () => (await session.invoke("import_tasks")).find(t => !previous.has(t.taskId))); }
  function quitOwnApp() { return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, windowsHide: true, stdio: "ignore" }); }
  return { until, wd, Session, begin, quitOwnApp };
}
