// #78 T15: real completed imports, rendered consent/close and backend receipt capabilities.
// Synthetic fixture uses public Rust core. Only native picker output uses the existing picker queue.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const [, , appArg, edgeArg, driverArg] = process.argv;
if (!appArg || !edgeArg) throw Error("Usage: node e2e/sealed-import-preview.mjs <frozen exe> <msedgedriver> [tauri-driver]");
const application = resolve(appArg), work = resolve(process.env.KINSHOKO_E2E_RUN ?? `work/e2e/sealed-preview-${Date.now()}`);
mkdirSync(work, { recursive: true });
const fixture = JSON.parse(readFileSync("work/e2e/t15-fixture.json", "utf8").replace(/^\uFEFF/, ""));
const build = JSON.parse(readFileSync("work/e2e/t15-build-source.json", "utf8").replace(/^\uFEFF/, ""));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
if (sha(readFileSync(application)) !== build.binarySha256) throw Error("Frozen executable does not match the source manifest");
const port = 4676, nativePort = 4677, url = `http://127.0.0.1:${port}`;
const appData = join(work, "app-data"), profile = join(work, "webview"), settingsPath = join(process.env.APPDATA, build.identifier, "settings.json");
const observedSettings = () => ({ path: settingsPath, exists: existsSync(settingsPath), ...(existsSync(settingsPath) ? { sha256: sha(readFileSync(settingsPath)), value: JSON.parse(readFileSync(settingsPath, "utf8")) } : {}) });
const result = { build, application, startedAt: new Date().toISOString(), paths: { work, appData, profile, settingsPath }, ports: { port, nativePort }, harnessSha256: sha(readFileSync(process.argv[1])), knownFolderBefore: observedSettings(), assertions: [], receipts: [], safeStates: [], races: [], transfers: [], largeOriginal: { bytes: readFileSync(fixture.sealedPath).length, sha256: sha(readFileSync(fixture.sealedPath)), width: 2400, height: 1800 } };
const assert = (ok, label) => { if (!ok) throw Error(label); result.assertions.push(label); console.log(`PASS ${label}`); };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(label, read, timeout = 30000) { let error; for (const end = Date.now() + timeout; Date.now() < end; await delay(150)) { try { const value = await read(); if (value) return value; } catch (reason) { error = reason; } } throw Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`); }
async function wd(method, path, body) { const response = await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); if (!response.ok || data.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(data.value)}`); return data.value; }
// Serialised into the real webview; this is the same public Channel protocol as src/ipc.ts.
function receiptRead(args, onFirstChunk) {
  return new Promise(resolve => {
    const ipc = window.__TAURI_INTERNALS__, startedAt = performance.now();
    let length = 0, chunks = 0, maximumChunkBytes = 0, firstChunkAt = null, lastChunkAt = null, acknowledgedAt = null, done = false, acknowledged = false, settled = false;
    const stats = () => ({ length, chunks, maximumChunkBytes, startedAt, firstChunkAt, lastChunkAt, acknowledgedAt, endedAt: performance.now(), elapsedMs: performance.now() - startedAt });
    const finish = () => { if (done && acknowledged && !settled) { settled = true; resolve(stats()); } };
    const callback = ipc.transformCallback(raw => {
      if (raw.end) { ipc.unregisterCallback(callback); return; }
      if (settled) return;
      const count = raw.message.byteLength ?? raw.message.length;
      if (count === 0) done = true;
      else {
        length += count; chunks++; maximumChunkBytes = Math.max(maximumChunkBytes, count); lastChunkAt = performance.now();
        if (firstChunkAt === null) { firstChunkAt = lastChunkAt; onFirstChunk?.(); }
      }
      finish();
    });
    ipc.invoke('plugin:library|read_import_preview', { ...args, onChunk: '__CHANNEL__:' + callback }).then(() => { acknowledged = true; acknowledgedAt = performance.now(); finish(); }, error => { settled = true; resolve({ ...stats(), failure: String(error) }); });
  });
}
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
class Session {
  constructor(id) { this.base = `/session/${id}`; }
  static async start() { const value = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } }); const session = new Session(value.sessionId); await until("main IPC", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);")); return session; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}, plugin = "library") { const value = await wd("POST", `${this.base}/execute/async`, { script: "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({failure:String(error)}));", args: [plugin ? `plugin:${plugin}|${command}` : command, args] }); if (value.failure) throw Error(`${command}: ${value.failure}`); return value.value; }
  async click(xpath) { return until("click " + xpath, async () => { const id = (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; await wd("POST", `${this.base}/element/${id}/click`, {}); return true; }); }
  select(label, value) { return this.exec("const e=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===arguments[0]&&e.getClientRects().length);if(!e)throw Error('select missing');e.value=arguments[1];e.dispatchEvent(new Event('change',{bubbles:true}));", [label, value]); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
  close() { return wd("DELETE", this.base); }
  async bytes(sessionId, itemId, targetPx = 640) { const value = await wd("POST", `${this.base}/execute/async`, { script: `const done=arguments[arguments.length-1];(${receiptRead})(arguments[0]).then(done);`, args: [{ sessionId, itemId, targetPx }] }); result.transfers.push({ sessionId, itemId, targetPx, ...value }); return value; }
  async readRace(preview, action, afterFirstChunk = false, targetPx = 319) {
    const value = await wd("POST", `${this.base}/execute/async`, { script: `const done=arguments[arguments.length-1],args=arguments[0],action=arguments[1],afterFirst=arguments[2],readPreview=${receiptRead};let ended=false,actionPromise,actionStartedAt,pendingAtAction;const act=()=>{if(actionPromise)return;pendingAtAction=!ended;actionStartedAt=performance.now();actionPromise=window.__TAURI_INTERNALS__.invoke(action.command,action.args).then(value=>({value,actionEndedAt:performance.now()}),error=>({failure:String(error),actionEndedAt:performance.now()}));};const read=readPreview(args,afterFirst?act:undefined).then(value=>{ended=true;return value;});if(!afterFirst)Promise.resolve().then(act);read.then(async value=>{if(!actionPromise)act();done({...value,pendingAtAction,actionStartedAt,...await actionPromise});});`, args: [{ sessionId: preview.id, itemId: preview.items[0], targetPx }, action, afterFirstChunk] });
    result.races.push({ action, afterFirstChunk, targetPx, ...value, actionElapsedMs: value.actionEndedAt - value.actionStartedAt }); return value;
  }
}
let session, driver;
const safe = async phase => { const on = await session.invoke("safe_mode"); result.safeStates.push({ phase, on }); assert(on === true, `actual global safe mode stays on: ${phase}`); };
const query = { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 };
const finish = id => until("real completed import", async () => { const r = (await session.invoke("import_tasks")).find(t => t.taskId === id); return r?.report && !r.finishing ? r : null; }, 90000);
async function openMenu() { if (!await session.exec("return document.querySelector('[aria-label=导入参考图]')?.getAttribute('aria-expanded')==='true';")) await session.click("//button[@aria-label='导入参考图']"); }
async function begin(paths) { const previous = new Set((await session.invoke("import_tasks")).map(t => t.taskId)); await openMenu(); await until("destination choices", () => session.exec("return [...document.querySelectorAll('select[aria-label=保存到资料库] option')].some(o=>o.value===arguments[0]);", [fixture.target.id])); await session.select("保存到资料库", fixture.target.id); await session.select("保存到文件夹", ""); await session.exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]];", [paths]); await session.click("//button[normalize-space()='导入文件…']"); await session.click("//button[normalize-space()='开始导入']"); return until("fixed receipt owner", async () => (await session.invoke("import_tasks")).find(t => !previous.has(t.taskId))); }
async function explicit(taskId) { return session.invoke("open_import_preview", { libraryId: fixture.target.id, taskId }); }
function quitOwnApp() { return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, windowsHide: true, stdio: "ignore" }); }
try {
  driver = spawn(driverArg ?? "tauri-driver", ["--port", String(port), "--native-port", String(nativePort), "--native-driver", resolve(edgeArg)], { env: { ...process.env, KINSHOKO_DATA_DIR: appData, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: profile }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
  await until("owned driver", () => fetch(url + "/status").then(r => r.ok)); session = await Session.start();
  await wd("POST", `${session.base}/timeouts`, { script: 120000 });
  result.environment = await session.exec("return {userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight};");
  await session.invoke("register_library", { root: fixture.adult.root }); await session.invoke("register_library", { root: fixture.target.root });
  await session.exec("location.reload();");
  await until("rendered current target", () => session.exec("return document.querySelector('select[aria-label=当前资料库]')?.value===arguments[0];", [fixture.target.id]));
  await delay(1800); await safe("before import");
  const before = await session.invoke("image", { libraryId: fixture.target.id, imageId: fixture.targetImage });
  const tagsBefore = await session.invoke("image_tags", { libraryId: fixture.target.id, imageId: fixture.targetImage, lang: "en" });
  const initial = await session.invoke("workspace_browse", { query, safeMode: true }); assert(initial.total === 1, "unknown target copy of a known Adult stays hidden while the ordinary unknown image remains visible");
  const running = await begin([fixture.sealedPath, fixture.visiblePath, fixture.newPath, join(work, "missing-file.png")]);
  const receipt = await finish(running.taskId); result.receipts.push(receipt);
  assert(receipt.destination.libraryId === fixture.target.id, "real import retains the fixed target owner");
  assert(receipt.report.sealedDuplicates && receipt.report.privateSummary && receipt.report.items.length === 1 && receipt.report.items[0].outcome.kind === "readFailed", "mixed default receipt exposes only real failure details, without success category counts or sealed IDs");
  assert(receipt.progress.done === 0 && receipt.progress.total === 0, "completed private progress cannot reveal sealed successes by subtracting failures");
  await until("default prompt", () => session.exec("return document.querySelector('[aria-label=导入结果]')?.textContent.includes('有封印项重复，是否展开看看');"));
  const defaultText = await session.exec("return document.querySelector('[aria-label=导入结果]').textContent;"); result.defaultText = defaultText;
  assert(!/新增|合并|更新 Eagle 信息/.test(defaultText) && !defaultText.includes("sealed-duplicate"), "rendered default report contains no exact success counts or sealed filename");
  assert(!await session.exec("return Boolean(document.querySelector('dialog.sealed-import-preview'));"), "no preview content exists before explicit consent");
  await session.screenshot("default-sealed-prompt.png"); await delay(1800);
  await session.click("//button[normalize-space()='展开本次重复项']");
  await until("real preview decoded", () => session.exec("return [...document.querySelectorAll('dialog.sealed-import-preview img')].some(i=>i.complete&&i.naturalWidth>0);"));
  assert(await session.exec("return document.querySelectorAll('dialog.sealed-import-preview img').length===1;"), "rendered consent shows only this receipt's sealed duplicate");
  await safe("UI expanded"); await session.screenshot("explicit-receipt-preview.png");
  await session.click("//button[@aria-label='关闭重复项预览']");
  await until("UI re-veiled", () => session.exec("return !document.querySelector('dialog.sealed-import-preview');"));
  await safe("UI closed"); await session.screenshot("closed-reveiled.png");
  const first = await explicit(receipt.taskId); assert(first.items.length === 1, "public preview capability derives exactly one actual receipt duplicate");
  assert((await session.bytes(first.id, first.items[0])).length > 0, "explicit receipt capability resolves real original content through the SDR path");
  assert(Boolean((await session.bytes(first.id, fixture.targetImage)).failure), "an arbitrary real UI image ID is not a preview capability item");
  await session.invoke("close_import_preview", { sessionId: first.id });
  assert(Boolean((await session.bytes(first.id, first.items[0])).failure), "closed backend session cannot read content again");
  const late = await explicit(receipt.taskId);
  const race = await session.readRace(late, { command: 'plugin:library|close_import_preview', args: { sessionId: late.id } });
  assert(race.pendingAtAction && Boolean(race.failure) && race.length === 0, "request begun before close cannot publish late image bytes");
  const large = await explicit(receipt.taskId), transfer = await session.bytes(large.id, large.items[0], 2400);
  assert(!transfer.failure && transfer.length === result.largeOriginal.bytes && transfer.chunks > 100 && transfer.maximumChunkBytes < 1024, "actual large original travels only in bounded direct receipt Channel chunks");
  const sendingClose = await session.readRace(large, { command: 'plugin:library|close_import_preview', args: { sessionId: large.id } }, true, 2400);
  assert(!sendingClose.failure && sendingClose.lastChunkAt <= sendingClose.actionEndedAt, "large transfer commits before close returns, without a later content fetch");
  assert(Boolean((await session.bytes(large.id, large.items[0])).failure), "large-transfer close remains effective after the actual send");
  const largeMode = await explicit(receipt.taskId);
  const sendingMode = await session.readRace(largeMode, { command: 'plugin:library|set_safe_mode', args: { on: true } }, true, 2400);
  assert(!sendingMode.failure && sendingMode.lastChunkAt <= sendingMode.actionEndedAt, "large transfer commits before same-mode generation transition returns");
  assert(Boolean((await session.bytes(largeMode.id, largeMode.items[0])).failure), "same-mode transition revokes the large-transfer receipt session"); await safe("large transfer same-mode transition");
  const switched = await explicit(receipt.taskId), switchRace = await session.readRace(switched, { command: 'plugin:library|switch_library', args: { libraryId: fixture.adult.id } });
  assert(switchRace.pendingAtAction && Boolean(switchRace.failure) && switchRace.length === 0, "pending image read cannot publish after current-library context changes");
  await session.invoke("switch_library", { libraryId: fixture.target.id });
  const settingsSession = await explicit(receipt.taskId), packagePath = join(work, "same-settings.kinshoko-settings");
  await session.invoke("export_application_settings", { path: packagePath }); const settingsPreview = await session.invoke("preview_application_settings", { path: packagePath });
  await session.invoke("restore_application_settings", { path: packagePath, fingerprint: settingsPreview.fingerprint });
  assert(Boolean((await session.bytes(settingsSession.id, settingsSession.items[0])).failure), "restoring the same safe-mode setting revokes the existing receipt capability"); await safe("same-mode settings restored");
  const secondRunning = await begin([fixture.sealedPath]); const secondReceipt = await finish(secondRunning.taskId); result.receipts.push(secondReceipt); await delay(1800);
  const older = await explicit(receipt.taskId);
  const nextRace = await session.readRace(older, { command: 'plugin:library|open_import_preview', args: { libraryId: fixture.target.id, taskId: secondReceipt.taskId } });
  assert(nextRace.pendingAtAction && Boolean(nextRace.failure) && nextRace.length === 0, "opening another receipt revokes pending old receipt content");
  const second = await explicit(secondReceipt.taskId);
  assert(Boolean((await session.bytes(second.id, first.items[0])).failure), "second receipt cannot consume an earlier receipt item");
  await session.invoke("set_safe_mode", { on: true });
  assert(Boolean((await session.bytes(second.id, second.items[0])).failure), "same-mode generation transition revokes consent"); await safe("same-mode transition");
  const dismiss = await explicit(secondReceipt.taskId); await session.invoke("dismiss_import", { libraryId: fixture.target.id, taskId: secondReceipt.taskId }); assert(Boolean((await session.bytes(dismiss.id, dismiss.items[0])).failure), "receipt dismissal revokes image access");
  const candidates = await session.invoke("workspace_candidates", { text: "t15-sealed-only", lang: "en", limit: 20, safeMode: true }); assert(candidates.length === 0, "ordinary candidates never reveal the hidden duplicate's tag");
  const after = await session.invoke("image", { libraryId: fixture.target.id, imageId: fixture.targetImage }); const tagsAfter = await session.invoke("image_tags", { libraryId: fixture.target.id, imageId: fixture.targetImage, lang: "en" });
  assert(JSON.stringify(before.note) === JSON.stringify(after.note) && JSON.stringify(tagsBefore) === JSON.stringify(tagsAfter) && after.rating.effective === null, "real preview leaves manual note, tags and unknown target classification unchanged");
  const final = await session.invoke("workspace_browse", { query, safeMode: true }); assert(final.total === 2, "ordinary browse and counts remain safe after preview");
  for (const [path, expected] of Object.entries(fixture.originals)) assert(sha(readFileSync(path)) === expected, "original SHA unchanged: " + path);
  result.knownFolderAfter = observedSettings(); result.diagnostics = await session.invoke("diagnostics_report", {}, null); result.status = "passed";
} catch (error) { result.status = "failed"; result.error = error.stack; console.error(error); if (session) await session.screenshot("failed.png").catch(() => {}); process.exitCode = 1; }
finally { result.finishedAt = new Date().toISOString(); result.knownFolderFinal = observedSettings(); writeFileSync(join(work, "result.json"), JSON.stringify(result, null, 2)); if (session) await session.close().catch(() => {}); quitOwnApp(); if (driver?.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
