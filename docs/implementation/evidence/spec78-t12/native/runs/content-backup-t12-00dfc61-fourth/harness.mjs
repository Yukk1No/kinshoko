// #78 T12: native library-content backup, restoration and interrupted-batch recovery.
// Fixture creation uses public IPC. Corrections, preferences, aliases, publication, backup,
// restoration and group opening use rendered controls. Only the file-picker result is queued.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, driverArg] = process.argv;
if (!appArg || !edgeArg) throw Error("Usage: node e2e/library-content-backup.mjs <owned kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const application = resolve(appArg);
const work = resolve(process.env.KINSHOKO_E2E_RUN ?? join("work/e2e", `content-backup-${Date.now()}`));
mkdirSync(work, { recursive: true });
const port = 4648;
const url = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const build = JSON.parse(readFileSync("work/e2e/t12-build-source.json", "utf8").replace(/^\uFEFF/, ""));
if (sha(readFileSync(application)).toLowerCase() !== build.binarySha256.toLowerCase()) throw Error("The native binary does not match the recorded product build");
const harnessSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const harnessSha256 = sha(readFileSync(resolve(process.argv[1])));
const assertions = [];
function assert(ok, label) { if (!ok) throw Error(label); assertions.push(label); console.log(`PASS ${label}`); }
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, read, timeout = 30000) {
  let error;
  for (const end = Date.now() + timeout; Date.now() < end; await delay(150)) {
    try { const value = await read(); if (value) return value; } catch (reason) { error = reason; }
  }
  throw Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
}
async function wd(method, path, body) {
  const response = await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(data.value)}`);
  return data.value;
}
class Session {
  static async start() {
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
    const session = new Session(result.sessionId);
    await until("formal main window", async () => {
      const handles = await wd("GET", `${session.base}/window/handles`);
      for (const handle of handles) {
        await wd("POST", `${session.base}/window`, { handle });
        if (await session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector('button[aria-label=设置]'));")) return true;
      }
      return false;
    });
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}, plugin = "library") {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:' + arguments[0] + '|' + arguments[1], arguments[2]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [plugin, command, args] });
    if (result.failure) throw Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
  click(xpath) { return until("click " + xpath, async () => { const id = await this.find(xpath); if (!await wd("GET", `${this.base}/element/${id}/enabled`)) return false; await wd("POST", `${this.base}/element/${id}/click`, {}); return true; }); }
  set(xpath, value) { return this.exec("const e = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!e) throw Error('control missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, arguments[1]); e.dispatchEvent(new Event('input', { bubbles: true }));", [xpath, value]); }
  select(xpath, value) { return this.exec("const e = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!e) throw Error('select missing'); e.value = arguments[1]; e.dispatchEvent(new Event('change', { bubbles: true }));", [xpath, value]); }
  pick(path) { return this.exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]];", [path]); }
  async refresh(libraryId) {
    await wd("POST", `${this.base}/refresh`, {});
    await until("rendered fixture library", () => this.exec("return document.querySelector('select[aria-label=当前资料库]')?.value === arguments[0];", [libraryId]));
  }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
  close() { return wd("DELETE", this.base); }
}
let session, driver, phase, dataDir;
const environments = [];
function quitOwnApp() {
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, windowsHide: true, stdio: "ignore" });
}
async function stop() {
  quitOwnApp();
  if (session) await session.close().catch(() => {});
  session = null;
  if (driver?.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  driver = null; await delay(450);
}
async function launch(name, profile, fault = null) {
  await stop(); phase = name; dataDir = join(work, profile); mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, KINSHOKO_DATA_DIR: dataDir, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, `webview-${name}`), KINSHOKO_FAULT: fault?.point ?? "", KINSHOKO_FAULT_ACTION: fault?.action ?? "" };
  driver = spawn(driverArg ?? "tauri-driver", ["--port", String(port), "--native-port", "4649", "--native-driver", resolve(edgeArg)], { env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
  await until("driver ready", () => fetch(url + "/status").then((r) => r.ok));
  session = await Session.start();
  const settingsPath = join(process.env.APPDATA, build.identifier, "settings.json");
  const settingsExists = existsSync(settingsPath);
  environments.push({ phase, dataDir, knownFolder: { path: settingsPath, exists: settingsExists, sha256: settingsExists ? sha(readFileSync(settingsPath)) : null, value: settingsExists ? JSON.parse(readFileSync(settingsPath, "utf8")) : null }, shellSettings: await command("shell_settings"), ...(await session.exec("const descriptor = Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__, 'invoke'); return { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent, invokeDescriptor: { writable: descriptor?.writable, configurable: descriptor?.configurable } };")) });
}
function png(path, seed) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff; for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(120); header.writeUInt32BE(90, 4); header[8] = 8; header[9] = 2;
  const rows = Array.from({ length: 90 }, (_, y) => { const row = Buffer.alloc(361); for (let x = 0; x < 120; x++) { row[x * 3 + 1] = (seed + x) % 256; row[x * 3 + 2] = y * 2; row[x * 3 + 3] = 38; } return row; });
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]));
}
function originals(root) {
  const result = {};
  function walk(dir) { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else result[p.slice(root.length + 1)] = sha(readFileSync(p)); } }
  walk(join(root, "originals")); return result;
}
const catalog = () => session.invoke("inspect_tag_catalog");
const mapping = (view, lib, local) => view.catalog.mappings.find((m) => m.libraryId === lib && m.localTagId === local);
const byIdentity = (view, id) => view.catalog.tags.find((t) => t.id === id);
const nameRow = (id) => `//tr[@data-catalog-name-id='${id}']`;
async function settings() {
  if (!await session.exec("return Boolean(document.querySelector('[aria-label=关闭设置]') || [...document.querySelectorAll('button')].some(e => e.textContent.trim() === '关闭设置'));")) await session.click("//button[@aria-label='设置']");
}
async function closeSettings() { await session.click("//button[normalize-space()='关闭设置']"); }
async function names(id) { await settings(); await session.click("//button[normalize-space()='管理显示名称']"); await until("name controls ready", () => session.exec("return [...document.querySelectorAll('fieldset[aria-label=标签显示名称] button')].find(e => e.textContent.trim() === '管理显示名称')?.disabled === false && Boolean(document.querySelector('select[aria-label=选择标签]'));")); await session.select("//select[@aria-label='选择标签']", id); await until("name row", () => session.find(nameRow(id))); }
async function prefer(id, value) { await names(id); await session.set(`${nameRow(id)}//input[contains(@aria-label,'偏好名称')]`, value); await session.click(`${nameRow(id)}//button[normalize-space()='保存偏好']`); await until("preference saved", async () => byIdentity(await catalog(), id)?.namePreferences.some((n) => n.name === value)); }
async function alias(id, value) { await names(id); await session.set(`${nameRow(id)}//input[contains(@aria-label,'新别名')]`, value); await session.click(`${nameRow(id)}//button[normalize-space()='加别名']`); await until("alias saved", async () => byIdentity(await catalog(), id)?.aliases.some((a) => a.name === value)); }
async function inspectControls() { await settings(); await session.click("//button[normalize-space()='检查标签对应']"); await until("identity controls ready", () => session.exec("return [...document.querySelectorAll('fieldset[aria-label=统一标签目录] button')].find(e => e.textContent.trim() === '检查标签对应')?.disabled === false && [...document.querySelectorAll('button')].some(e => e.textContent.trim() === '保存标签定义到资料库');")); }
async function publish(name, failure = false) {
  await inspectControls(); await session.click(`//button[@aria-label='保存 ${name} 的标签定义']`);
  await until(failure ? "visible publication failure" : "visible publication success", () => session.exec(failure ? "return [...document.querySelectorAll('[role=alert]')].some(e => e.textContent.includes('程序中的对应和名称选择已保留') && e.textContent.includes('重试'));" : "return [...document.querySelectorAll('[role=status]')].some(e => e.textContent.includes('标签定义已保存到资料库'));"));
}
async function correct(library, local, target) {
  const prior = mapping(await catalog(), library.id, local).catalogId;
  await inspectControls(); const row = `//tr[@data-library-id='${library.id}' and @data-local-tag-id='${local}']`;
  await session.select(`${row}//select`, target); await session.click(`${row}//button[normalize-space()='保存对应']`);
  return until("saved correction", async () => { const value = mapping(await catalog(), library.id, local); return value?.basis === "corrected" && (target === "separate" ? value.catalogId !== prior : value.catalogId === target) ? value.catalogId : null; });
}
async function create(name, paths) {
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name });
  const taskId = await session.invoke("start_import", { libraryId: info.id, source: { paths }, destination: { libraryId: info.id, folderId: null } });
  const receipt = await until("fixed import owner and definition publication " + name, async () => { const task = (await session.invoke("import_tasks")).find(item => item.taskId === taskId); return task?.report && !task.finishing ? task : null; });
  assert(receipt.destination.libraryId === info.id && receipt.destination.folderId === null && receipt.warnings.length === 0, "fixture import has its explicit owner and completed definition publication: " + name);
  const page = await until("ordinary import " + name, async () => { const p = await session.invoke("browse", { libraryId: info.id, query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 } }); return p.cards.length === paths.length ? p : null; });
  const images = page.cards.map((c) => c.id);
  await session.invoke("edit_tags", { libraryId: info.id, imageIds: images, edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "白", lang: "zh-CN" } }] });
  const local = (await session.invoke("vocabulary", { libraryId: info.id })).tags.find((t) => t.names.some((n) => n.name === "白")).id;
  await session.refresh(info.id);
  return { info, images, local, receipt };
}
async function groupsPane() { if (!await session.exec("return document.querySelector('button[aria-label=参考组]')?.getAttribute('aria-expanded') === 'true';")) await session.click("//button[@aria-label='参考组']"); await until("groups pane", () => session.find("//input[@aria-label='新参考组名称']")); }
async function pin(library, image, crop) {
  const prior = existsSync(join(dataDir, "pins.json")) ? JSON.parse(readFileSync(join(dataDir, "pins.json"), "utf8")).pins.map((p) => p.id) : [];
  await session.invoke("pin_reference", { libraryId: library.id, imageId: image, crop, shown: { x: 300, y: 220, width: 240, height: 180 } }, "desktop");
  return until("real persisted pin", () => { if (!existsSync(join(dataDir, "pins.json"))) return null; return JSON.parse(readFileSync(join(dataDir, "pins.json"), "utf8")).pins.find((p) => !prior.includes(p.id)); });
}
async function command(command, args = {}) {
  const result = await wd("POST", `${session.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
  if (result.failure) throw Error(`${command}: ${result.failure}`);
  return result.value;
}
async function backupSettings() { await settings(); await until("library backup settings", () => session.find("//section[@aria-label='资料库备份']//h2[normalize-space()='资料库备份']")); }
const backupSection = "//section[@aria-label='资料库备份']";
async function chooseBackup(path) {
  await backupSettings(); await session.pick(path); await session.click(`${backupSection}//button[normalize-space()='选择备份目录…']`);
  await until("saved backup destination", async () => (await command("backup_status")).plan.target === path);
}
function restoreProvenance(libraries) {
  const script = "import sqlite3,json,sys,pathlib; result=[]\nfor root in json.loads(sys.argv[1]):\n db=sqlite3.connect((pathlib.Path(root)/'library.sqlite').resolve().as_uri()+'?mode=ro',uri=True)\n db.execute('PRAGMA query_only=ON')\n rows=db.execute('SELECT old_library_id, backup_id, restored_at FROM restore_provenance ORDER BY restored_at,rowid').fetchall()\n result.append({'root':root,'provenance':[{'oldLibraryId':row[0],'backupId':row[1],'restoredAt':row[2]} for row in rows]})\n db.close()\nprint(json.dumps(result))";
  const read = spawnSync("python", ["-c", script, JSON.stringify(libraries.map(library => library.root))], { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
  if (read.status !== 0) throw Error("Read-only restored provenance: " + read.stderr);
  return JSON.parse(read.stdout);
}
async function restoreRendered(into) {
  mkdirSync(into, { recursive: true }); await backupSettings();
  const beforeLibraries = new Set((await session.invoke("registered_libraries")).map(entry => entry.library.id));
  const beforeGroups = new Set((await session.invoke("reference_groups", {}, "desktop")).map(group => group.id));
  await session.click(`${backupSection}//button[normalize-space()='从备份恢复…']`);
  await session.pick(into); await session.click(`${backupSection}//button[starts-with(@aria-label,'恢复 ')]`);
  const completed = await until("rendered roundtrip success and actual new registrations/groups", async () => {
    const libraries = (await session.invoke("registered_libraries")).filter(entry => !beforeLibraries.has(entry.library.id)).map(entry => entry.library);
    const groups = (await session.invoke("reference_groups", {}, "desktop")).filter(group => !beforeGroups.has(group.id));
    const rendered = await session.exec("const result = document.querySelector('[aria-label=往返检查]'); const buttons = [...document.querySelectorAll('.backup-snapshots button')]; return result && result.innerText.includes('往返检查通过') && buttons.every(button => !button.disabled) ? result.innerText : null;");
    return libraries.length === 2 && groups.length === 1 && rendered ? { libraries, groups, rendered } : null;
  }, 45000);
  const provenance = restoreProvenance(completed.libraries);
  const libraries = completed.libraries.map(library => {
    const rows = provenance.find(entry => entry.root === library.root).provenance;
    const from = rows.at(-1);
    assert(from?.backupId === backupReport.snapshotId, "actual restored library provenance names the selected content snapshot");
    return { library, oldId: from.oldLibraryId, provenance: rows };
  });
  const groups = [];
  for (const summary of completed.groups) {
    const group = (await session.invoke("reference_group", { groupId: summary.id }, "desktop")).group;
    assert(group.restoredFrom?.backupId === backupReport.snapshotId, "actual restored reference-group provenance names the selected content snapshot");
    groups.push({ oldId: group.restoredFrom.groupId, id: group.id, name: group.name });
  }
  assert(completed.rendered.includes("往返检查通过") && /原图 3 张/.test(completed.rendered) && /参考组 1 个/.test(completed.rendered), "rendered content restore reports matching originals, curation and groups");
  return { observation: "Actual rendered completion plus public registrations/groups and read-only SQLite provenance; not an intercepted restore_backup response", snapshotId: backupReport.snapshotId, libraries, groups, renderedCheck: completed.rendered };
}
async function openRestored(info) {
  await closeSettings();
  if (!await session.exec("return document.querySelector('button[aria-label=图片与文件夹]')?.getAttribute('aria-expanded') === 'true';")) await session.click("//button[@aria-label='图片与文件夹']");
  await session.exec("const details = document.querySelector('details.library-tools'); if(details) details.open = true;");
  await session.click("//button[normalize-space()='刷新登记']");
  await until("restored library option", () => session.exec("return [...document.querySelectorAll('select[aria-label=当前资料库] option')].some(option => option.value === arguments[0]);", [info.id]));
  await session.select("//select[@aria-label='当前资料库']", info.id);
  await until("restored wall opened", () => session.exec("return document.querySelector('select[aria-label=当前资料库]')?.value === arguments[0] && document.querySelectorAll('.card').length > 0;", [info.id]));
}
async function removeAlias(identity, value) {
  await names(identity); await session.click(`${nameRow(identity)}//button[@aria-label='去掉别名“${value}”']`);
  await until("deleted alias stays absent", async () => !byIdentity(await catalog(), identity).aliases.some(alias => alias.name === value));
}
function groupState(groups) { return groups.map(group => group.id).sort().join(); }
function programGroups(groups) { return groups.map(group => ({ id: group.id, name: group.name, namespace: group.namespace, tagIds: group.tags.map(item => item.tag.id) })); }
function personalRules(view) { return view.entries.map(entry => ({ a: entry.a.id, b: entry.b.id, relation: entry.relation, sources: entry.sources })); }
function reportFiles(report) { return report.libraries.flatMap(library => Object.values(originals(library.library.root))).sort(); }
const backupDir = join(work, "backup"); mkdirSync(backupDir);
let sourceA, sourceB, sourceIdentity, splitIdentity, sourceGroup, backupReport, freshReport, existingReport;
let existingGroupId, approxBefore, groupsBefore, expectedOriginals;
const faultResults = [];
try {
  const paths = ["a1", "a2", "b"].map((name, i) => { const path = join(work, name + ".png"); png(path, 20 + i * 47); return path; });
  await launch("source", "source-app");
  sourceA = await create("备份来源甲", paths.slice(0, 2));
  await session.invoke("map_tag_external", { libraryId: sourceA.info.id, tagId: sourceA.local, external: "t12_backup_white" });
  await session.invoke("edit_tags", { libraryId: sourceA.info.id, imageIds: [sourceA.images[0]], edits: [{ kind: "add", tag: { kind: "named", namespace: "artist", name: "白", lang: "zh-CN" } }, { kind: "reject", tag: { kind: "named", namespace: "general", name: "拒绝项", lang: "zh-CN" } }] });
  const folder = await session.invoke("create_folder", { libraryId: sourceA.info.id, name: "备份头部", parent: null });
  await session.invoke("edit", { libraryId: sourceA.info.id, ids: [sourceA.images[0]], edits: [{ kind: "setNote", text: "备份保留人工备注" }, { kind: "addToFolder", folderId: folder }, { kind: "setRating", rating: "sensitive" }] });
  sourceB = await create("备份来源乙", paths.slice(2));
  let view = await catalog(); sourceIdentity = mapping(view, sourceA.info.id, sourceA.local).catalogId;
  await correct(sourceB.info, sourceB.local, sourceIdentity);
  await prefer(sourceIdentity, "源程序偏好"); await alias(sourceIdentity, "旧别名"); await publish(sourceA.info.name); await closeSettings();
  await session.invoke("create_shared_tag_group", { name: "源程序的分组", namespace: null });
  const firstPin = await pin(sourceA.info, sourceA.images[0], { x: 10, y: 12, width: 50, height: 40 });
  await session.invoke("turn_pin", { pin: firstPin.id, turn: "flipHorizontal" }, "desktop");
  await session.invoke("turn_pin", { pin: firstPin.id, turn: "rotateClockwise" }, "desktop");
  await session.invoke("zoom_pin", { pin: firstPin.id, scale: 1.5, anchorX: 300, anchorY: 220 }, "desktop");
  await pin(sourceA.info, sourceA.images[1], null); await pin(sourceB.info, sourceB.images[0], { x: 4, y: 5, width: 70, height: 60 });
  await groupsPane(); await session.set("//input[@aria-label='新参考组名称']", "内容备份跨库组"); await session.click("//button[normalize-space()='把桌面钉图存为参考组']");
  sourceGroup = await until("source reference group", async () => { const group = (await session.invoke("reference_groups", {}, "desktop")).find(group => group.name === "内容备份跨库组"); return group ? (await session.invoke("reference_group", { groupId: group.id }, "desktop")).group : null; });
  assert(sourceGroup.members.length === 3, "three native reference views become one cross-library source group");
  expectedOriginals = [sourceA.info, sourceB.info].flatMap(info => Object.values(originals(info.root))).sort();
  await session.screenshot("01-source-group.png");
  await launch("source-publication-failed", "source-app", { point: "portable_tags_publish_row@1", action: "error" });
  splitIdentity = await correct(sourceB.info, sourceB.local, "separate");
  assert(splitIdentity !== sourceIdentity, "app split is saved despite a real provider definition publication failure");
  assert(await until("formal provider publication failure", () => session.exec("return [...document.querySelectorAll('[role=alert]')].some(e => e.textContent.includes('标签对应已保存在程序中') && e.textContent.includes('资料库定义尚未更新') && e.textContent.includes('重试'));")), "provider publication failure is visible in the formal identity controls");
  await removeAlias(sourceIdentity, "旧别名"); await alias(sourceIdentity, "白雪新别名");
  await session.invoke("edit_shared_approx", { safeMode: true, edit: { kind: "set", rules: [{ a: sourceIdentity, b: splitIdentity, relation: "similar" }] } });
  assert((await session.invoke("shared_personal_approx", { lang: "zh-CN", safeMode: true })).entries.some(entry => entry.relation === "similar"), "source has an actual application personal rule before content backup");
  await chooseBackup(backupDir);
  const preview = await command("backup_preview", { selection: { kind: "all" } });
  assert(preview.scope.libraries.length === 2 && preview.scope.groups.length === 1 && preview.estimate.originals === 3, "actual backup preview covers both providers, their group and all originals");
  assert(await session.exec("return document.querySelector('[aria-label=资料库备份]')?.textContent.includes('恢复资料库保留当前程序设置');"), "formal library-backup entry states the content/settings boundary");
  await session.click(`${backupSection}//button[normalize-space()='马上备份']`);
  backupReport = await until("complete manual content backup", async () => { const status = await command("backup_status"); return status.running === null && status.lastReport?.complete ? status.lastReport : null; });
  assert(backupReport.copied === 3 && backupReport.skipped.length === 0 && backupReport.problems.length === 0, "manual content backup completes after failed publication without skipping providers");
  await session.screenshot("02-backup-preview.png");
  await stop(); renameSync(join(work, "libraries"), join(work, "source-libraries-disconnected"));
  await launch("fresh-restore", "fresh-app"); await chooseBackup(backupDir);
  freshReport = await restoreRendered(join(work, "fresh-restored"));
  assert(freshReport.libraries.length === 2 && freshReport.groups.length === 1 && freshReport.libraries.every(library => library.library.id !== library.oldId), "fresh restoration creates independent library and reference-group identities");
  assert(JSON.stringify(reportFiles(freshReport)) === JSON.stringify(expectedOriginals), "fresh content restoration preserves every original byte hash");
  view = await catalog();
  assert(mapping(view, freshReport.libraries.find(library => library.oldId === sourceA.info.id).library.id, sourceA.local)?.catalogId === sourceIdentity && mapping(view, freshReport.libraries.find(library => library.oldId === sourceB.info.id).library.id, sourceB.local)?.catalogId === splitIdentity, "fresh app interprets the current corrected and split identities without the source catalog");
  assert(view.catalog.tags.every(tag => tag.namePreferences.length === 0) && byIdentity(view, sourceIdentity).defaultNames.some(name => name.name === "白"), "content defaults never become source application preferences");
  assert(byIdentity(view, sourceIdentity).aliases.some(alias => alias.name === "白雪新别名") && !byIdentity(view, sourceIdentity).aliases.some(alias => alias.name === "旧别名"), "content backup captures current alias deletion and additions after stale provider publication");
  assert(view.catalog.tags.some(tag => tag.namespace === "artist") && byIdentity(view, sourceIdentity).external.some(external => external.name === "t12_backup_white"), "restored tags retain namespaces and external correspondence");
  assert((await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true })).length === 0 && (await session.invoke("shared_personal_approx", { lang: "zh-CN", safeMode: true })).entries.length === 0, "source application groups and personal rules are absent from fresh content restoration");
  const restoredGroup = (await session.invoke("reference_group", { groupId: freshReport.groups[0].id }, "desktop")).group;
  assert(restoredGroup.restoredFrom.groupId === sourceGroup.id && restoredGroup.restoredFrom.backupId === backupReport.snapshotId && restoredGroup.members.every((member, i) => member.libraryId === freshReport.libraries.find(library => library.oldId === sourceGroup.members[i].libraryId).library.id && member.imageId === sourceGroup.members[i].imageId && JSON.stringify(member.crop) === JSON.stringify(sourceGroup.members[i].crop) && JSON.stringify(member.placement) === JSON.stringify(sourceGroup.members[i].placement)), "restored group provenance, remapped members, crops and layouts match the source");
  await session.screenshot("03-fresh-restore-result.png");
  const freshA = freshReport.libraries.find(library => library.oldId === sourceA.info.id).library;
  await openRestored(freshA);
  const detail = await session.invoke("image", { libraryId: freshA.id, imageId: sourceA.images[0] });
  assert(detail.note.manual === "备份保留人工备注" && detail.folders.some(folder => folder.name === "备份头部"), "opening the restored library exposes the original note and directory curation");
  await groupsPane(); await session.click(`//li[@data-id='${freshReport.groups[0].id}']//button[normalize-space()='成员']`);
  await until("available restored members", () => session.exec("return document.querySelectorAll('.reference-group-members li').length === 3 && [...document.querySelectorAll('.reference-group-members li')].every(item => item.textContent.includes('可用'));"));
  await session.click(`//li[@data-id='${freshReport.groups[0].id}']//button[normalize-space()='钉到桌面']`);
  await until("native restored reference pins", () => existsSync(join(dataDir, "pins.json")) && JSON.parse(readFileSync(join(dataDir, "pins.json"), "utf8")).pins.length === 3);
  assert(true, "restored group opens as three real native reference pins"); await session.screenshot("04-open-restored-group.png");
  await prefer(sourceIdentity, "目标程序偏好"); await removeAlias(sourceIdentity, "白雪新别名"); await closeSettings();
  existingGroupId = await session.invoke("create_shared_tag_group", { name: "目标程序分组", namespace: null });
  await session.invoke("edit_shared_tag_group", { safeMode: true, edit: { kind: "addMembers", groupId: existingGroupId, tagIds: [sourceIdentity, splitIdentity] } });
  await session.invoke("edit_shared_approx", { safeMode: true, edit: { kind: "set", rules: [{ a: sourceIdentity, b: splitIdentity, relation: "notSimilar" }] } });
  const groupsSettingsBefore = await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true });
  approxBefore = await session.invoke("shared_personal_approx", { lang: "zh-CN", safeMode: true });
  existingReport = await restoreRendered(join(work, "existing-restored")); view = await catalog();
  assert(byIdentity(view, sourceIdentity).namePreferences.some(name => name.name === "目标程序偏好") && !byIdentity(view, sourceIdentity).aliases.some(alias => alias.name === "白雪新别名"), "existing app keeps its explicit preference and deleted alias after another content restore");
  const groupSettingsAfter = await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true });
  assert(JSON.stringify(programGroups(groupSettingsAfter)) === JSON.stringify(programGroups(groupsSettingsBefore)) && groupSettingsAfter.find(group => group.id === existingGroupId)?.tags.length === 2, "existing program group definition survives content restoration");
  const approxAfter = await session.invoke("shared_personal_approx", { lang: "zh-CN", safeMode: true });
  assert(approxBefore.entries.length === 1 && JSON.stringify(personalRules(approxAfter)) === JSON.stringify(personalRules(approxBefore)), "existing personal approximate decisions survive content restoration");
  assert(JSON.stringify(reportFiles(existingReport)) === JSON.stringify(expectedOriginals), "restoring into an existing environment preserves original bytes again");
  await session.screenshot("05-existing-settings.png");
  const registrationsBefore = await session.invoke("registered_libraries");
  groupsBefore = await session.invoke("reference_groups", {}, "desktop");
  for (const point of ["content_restore_library_published", "content_restore_group_published"]) {
    const label = point.includes("library") ? "library" : "group";
    const into = join(work, `fault-${label}-restored`); mkdirSync(into);
    await launch(`fault-${label}`, "fresh-app", { point: `${point}@1`, action: "exit" });
    let failure; try { await restoreRendered(into); } catch (error) { failure = String(error); }
    assert(Boolean(failure), `native process interruption after ${label} publication prevents a success response`);
    const journalDir = join(dataDir, "reference-groups", "restore-transactions");
    const pendingJournals = readdirSync(journalDir).filter(name => name.endsWith(".json"));
    assert(pendingJournals.length === 1, `native ${label} interruption leaves one durable batch recovery record`);
    const interrupted = JSON.parse(readFileSync(join(journalDir, pendingJournals[0]), "utf8"));
    const publishedLibraries = interrupted.libraries.filter(library => existsSync(library.root));
    const publishedGroups = interrupted.groups.filter(group => existsSync(join(dataDir, "reference-groups", group.id + ".json")));
    assert(interrupted.libraries.length === 2 && interrupted.groups.length === 1 && publishedLibraries.length === (label === "library" ? 1 : 2) && publishedGroups.length === (label === "library" ? 0 : 1), `native ${label} interruption actually occurs after the required publication boundary`);
    faultResults.push({ point, failure, pendingJournals, interrupted, publishedLibraries, publishedGroups, partialDestinations: readdirSync(into) });
    await launch(`recover-${label}`, "fresh-app");
    assert(readdirSync(into).length === 0, `native startup rolls back the full interrupted ${label} publication batch`);
    assert(groupState(await session.invoke("reference_groups", {}, "desktop")) === groupState(groupsBefore), `startup recovery keeps every pre-existing reference group after ${label} interruption`);
    assert((await session.invoke("registered_libraries")).map(entry => entry.library.id).sort().join() === registrationsBefore.map(entry => entry.library.id).sort().join(), `startup recovery keeps all pre-existing library registrations after ${label} interruption`);
    view = await catalog(); const currentApprox = await session.invoke("shared_personal_approx", { lang: "zh-CN", safeMode: true });
    assert(byIdentity(view, sourceIdentity).namePreferences.some(name => name.name === "目标程序偏好") && !byIdentity(view, sourceIdentity).aliases.some(alias => alias.name === "白雪新别名") && JSON.stringify(personalRules(currentApprox)) === JSON.stringify(personalRules(approxBefore)) && JSON.stringify(programGroups(await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true }))) === JSON.stringify(programGroups(groupsSettingsBefore)), `startup recovery retains current preferences, alias deletion, program groups and personal rules after ${label} interruption`);
    assert(JSON.stringify(reportFiles(freshReport)) === JSON.stringify(expectedOriginals) && JSON.stringify(reportFiles(existingReport)) === JSON.stringify(expectedOriginals), `startup recovery preserves every pre-existing original byte after ${label} interruption`);
    const retry = await restoreRendered(into);
    assert(retry.libraries.length === 2 && retry.groups.length === 1 && JSON.stringify(reportFiles(retry)) === JSON.stringify(expectedOriginals), `rendered retry completes all libraries and groups after ${label} interruption`);
    await session.screenshot(`06-recovered-${label}.png`);
    groupsBefore = await session.invoke("reference_groups", {}, "desktop");
    registrationsBefore.splice(0, registrationsBefore.length, ...(await session.invoke("registered_libraries")));
  }
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", application, build, harnessSource, harnessSha256, assertions, environments, sourceA, sourceB, sourceIdentity, splitIdentity, sourceGroup, backupReport, freshReport, existingReport, faultResults, expectedOriginals, filePicker: "existing testPick result queue; actual rendered controls/native backend", observer: "actual rendered roundtrip completion, public registrations/reference groups, and SQLite mode=ro/query_only provenance; no invoke replacement or synthetic IPC response", cleanup: "forced exact executable restarts; not normal tray-quit acceptance" }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) { await session.screenshot(`failure-${phase}.png`).catch(() => {}); await session.exec("return document.documentElement.outerHTML;").then(html => writeFileSync(join(work, `failure-${phase}.html`), html)).catch(() => {}); }
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", phase, error: String(error), application, build, harnessSource, harnessSha256, assertions, environments, sourceA, sourceB, sourceIdentity, splitIdentity, sourceGroup, backupReport, freshReport, existingReport, faultResults }, null, 2)); process.exitCode = 1;
} finally { await stop(); }
