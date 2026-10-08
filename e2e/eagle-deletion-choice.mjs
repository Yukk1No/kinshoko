// #78 T14 / #93: real WebView2 import choices, deletion memory, recycle-bin recovery and retry.
// Run serially with other native tests. Use an isolated identifier and this script's own app-data/WebView dirs.
// node e2e/eagle-deletion-choice.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, driverArg = "tauri-driver"] = process.argv;
if (!appArg || !edgeArg) throw new Error("node e2e/eagle-deletion-choice.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const work = mkdtempSync(join(tmpdir(), "kinshoko-spec78-t14-"));
const output = resolve(process.env.KINSHOKO_EAGLE_OUTPUT ?? "work/native/eagle-deletion-choice");
const application = join(work, "kinshoko-spec78-t14.exe");
const parent = join(work, "libraries");
const sourceParent = join(work, "selected-parent");
const source = join(sourceParent, "Eagle.library");
const item = join(source, "images", "ITEM000000000.info");
const original = join(item, "test.png");
for (const dir of [output, parent, item, join(work, "roaming"), join(work, "local")]) mkdirSync(dir, { recursive: true });
copyFileSync(resolve(appArg), application);
const crcTable = Array.from({ length: 256 }, (_, crc) => { for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; return crc >>> 0; });
function chunk(type, bytes) {
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, tail]);
}
function png(width, height, seed) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    pixels[at] = seed; pixels[at + 1] = x * 7 % 256; pixels[at + 2] = y * 9 % 256;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const firstBytes = png(240, 180, 80);
const newBytes = png(310, 130, 180);
const metadata = { id: "ITEM000000000", name: "test", ext: "png", size: firstBytes.length, width: 240, height: 180,
  tags: ["Eagle 标签"], folders: [], annotation: "Eagle 原备注", url: "https://example.com/t14", isDeleted: false,
  btime: 1756571097667, comments: [] };
const saveItem = () => writeFileSync(join(item, "metadata.json"), JSON.stringify(metadata));
writeFileSync(join(source, "metadata.json"), JSON.stringify({ folders: [], applicationVersion: "4.0.0" }));
writeFileSync(original, firstBytes); saveItem();

const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4480);
const endpoint = `http://127.0.0.1:${port}`;
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const report = { stories: [38, 39, 40], ticket: 93, windows: release(), sourceRevision: process.env.KINSHOKO_SOURCE_REVISION ?? "uncommitted", identifier: "dev.kinshoko.spec78t14test", ports: [port, port + 1], checks: [] };
function check(ok, label) { if (!ok) throw new Error(label); report.checks.push(label); console.log(`✓ ${label}`); }
async function wd(method, path, body) {
  const response = await fetch(endpoint + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return path === "/session" && result.sessionId ? { sessionId: result.sessionId, capabilities: result.value } : result.value;
}
async function until(label, read) {
  let last; const end = Date.now() + 30000;
  while (Date.now() < end) { try { const result = await read(); if (result) return result; } catch (error) { last = error; } await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}
let base, driver, stopped;
const exec = (script, args = []) => wd("POST", `${base}/execute/sync`, { script, args });
async function invoke(command, args = {}) {
  const result = await wd("POST", `${base}/execute/async`, { script: `const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ok:true,value}), error => done({ok:false,error:String(error)}));`, args: [command, args] });
  if (!result.ok) throw new Error(`${command}: ${result.error}`); return result.value;
}
const lib = (name, args = {}) => invoke(`plugin:library|${name}`, { libraryId, ...args });
let libraryId;
const find = async xpath => { const element = await wd("POST", `${base}/element`, { using: "xpath", value: xpath }); return element[elementKey] ?? element.ELEMENT; };
const clickXPath = async xpath => wd("POST", `${base}/element/${await find(xpath)}/click`, {});
const click = text => clickXPath(`//button[normalize-space()='${text}']`);
const screenshot = async name => writeFileSync(join(output, `${name}.png`), Buffer.from(await wd("GET", `${base}/screenshot`), "base64"));
const browse = (scope = "all") => lib("browse", { query: { scope: { kind: scope }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 256 } });
const detail = id => lib("image", { imageId: id });
const policy = () => exec("return !!document.querySelector('[aria-label=\"Eagle 重导选择\"]')");
const defaultChecked = () => exec("return [...document.querySelectorAll('[aria-label=\"Eagle 重导选择\"] input')].map(i=>i.checked)");
async function closeTagStep() {
  if (await exec("return !!document.querySelector('[aria-label=\"标签的外部对应\"]')")) await clickXPath("//*[@aria-label='标签的外部对应']/header/button");
}
async function importMenu(open) {
  const current = await exec("const b=document.querySelector('button[aria-label=\"导入参考图\"]'); return b ? b.getAttribute('aria-expanded')==='true' : null;");
  if (current !== null && current !== open) await clickXPath("//button[@aria-label='导入参考图']");
}
async function prepare(path = sourceParent) {
  await closeTagStep(); await importMenu(true);
  await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [path]); await click("导入文件夹…");
  await until("Eagle policy step", policy);
}
async function finishImport() {
  await click("开始 Eagle 导入");
  await until("import completed", async () => !(await policy()) && await exec("return document.querySelector('[aria-label=\"导入结果\"]')?.textContent || null"));
  await closeTagStep();
  return exec("return document.querySelector('[aria-label=\"导入结果\"]')?.textContent || ''");
}
async function selectCard(id) {
  await importMenu(false);
  const card = await until("visible reference card", () => find(`//*[@data-id='${id}']`));
  await wd("POST", `${base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE009" }] }] });
  try { await wd("POST", `${base}/element/${card}/click`, {}); } finally { await wd("DELETE", `${base}/actions`); }
  await until("reference selected", () => find("//aside[@aria-label='已选参考图']"));
}
async function showAll() { await importMenu(false); await clickXPath("//button[starts-with(@aria-label,'全部（')]"); }
async function deleteViaUi(id) {
  await showAll(); await selectCard(id); await click("删除");
  await until("soft delete", async () => (await detail(id)).deletedAt !== null);
  await clickXPath("//button[starts-with(@aria-label,'回收站（')]");
  await selectCard(id); await click("永久删除…");
  await until("delete preview", () => find("//*[@role='alertdialog' and @aria-label='永久删除']"));
  await click("确认永久删除");
  await until("permanent delete", async () => (await lib("sidebar")).trash === 0);
}
async function startSession() {
  driver = spawn(driverArg, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
    windowsHide: true, env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1" }, stdio: ["ignore", "inherit", "inherit"] });
  stopped = new Promise(done => driver.once("exit", done));
  await until("driver ready", () => fetch(`${endpoint}/status`).then(response => response.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
  base = `/session/${session.sessionId}`;
  report.runtime = { browserName: session.capabilities.browserName, browserVersion: session.capabilities.browserVersion, platformName: session.capabilities.platformName };
}
async function stopSession() {
  if (base) { try { await wd("DELETE", base); } catch {} base = null; }
  if (driver) {
    spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    driver.kill(); await Promise.race([stopped, new Promise(done => setTimeout(done, 3000))]); driver = null;
  }
}
try {
  await startSession();
  const name = await until("create library", () => find("//label[contains(.,'资料库名称')]/input"));
  await wd("POST", `${base}/element/${name}/clear`, {}); await wd("POST", `${base}/element/${name}/value`, { text: "Eagle 删除选择验证" });
  await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [parent]); await click("选择存放位置…"); await click("建立资料库");
  const current = await until("target library open", () => invoke("plugin:library|current_library")); libraryId = current.id;
  check(true, "Created an isolated real target library through the production UI");
  report.dpr = await exec("return devicePixelRatio");
  report.diagnostics = await invoke("diagnostics_report");

  await prepare();
  check(JSON.stringify(await defaultChecked()) === "[true,false]", "Selected parent folder is recognized as Eagle and defaults to skipping deleted content");
  const before = await lib("sidebar");
  await screenshot("default-choice"); await clickXPath("//*[@aria-label='Eagle 重导选择']//button[normalize-space()='取消']");
  check((await browse()).total === 0 && (await lib("sidebar")).folders.length === before.folders.length, "Cancelling before start leaves the target library unchanged");
  await prepare(); await finishImport();
  let cards = await browse(); const first = cards.cards[0].id;
  check(cards.total === 1, "Default wizard imports new Eagle content");
  await deleteViaUi(first);
  await prepare(); let text = await finishImport();
  check(text.includes("曾永久删除的同一内容已跳过") && (await browse()).total === 0, "Default reimport reports skipped permanently deleted content");
  await screenshot("default-skip-report");

  await click("重新选择永久删除重导策略…"); await until("allow choice", policy);
  await clickXPath("//*[@aria-label='Eagle 重导选择']//label[contains(.,'允许本次重新导入')]/input");
  await screenshot("allow-this-import"); await finishImport();
  cards = await browse(); const allowed = cards.cards[0].id;
  check(cards.total === 1 && allowed !== first, "Explicit allow-this-import recreates the same content");
  const folder = await lib("create_folder", { name: "本库整理", parent: null });
  await lib("edit", { ids: [allowed], edits: [{ kind: "setNote", text: "人工备注" }, { kind: "addToFolder", folderId: folder }] });
  metadata.annotation = "Eagle 更新备注"; saveItem();
  await prepare();
  check((await defaultChecked())[0], "A later import resets to the default deletion choice");
  text = await finishImport(); const curated = await detail(allowed);
  check(text.includes("更新 Eagle 信息") && curated.note.manual === "人工备注" && curated.folders.some(entry => entry.id === folder), "Normal reimport refreshes Eagle facts while preserving manual notes and folders");

  await showAll(); await selectCard(allowed); await click("删除");
  await until("trash item", async () => (await detail(allowed)).deletedAt !== null);
  await prepare(); text = await finishImport();
  check(text.includes("有内容与回收站重复，已保持删除状态") && (await detail(allowed)).deletedAt !== null, "Trash duplicates retain deletion and show a generic restore entry");
  check(!text.includes("test") && !/回收站重复.*\d/.test(text), "The duplicate notice exposes neither image names nor a duplicate count");
  await screenshot("trash-duplicate"); await click("前往回收站恢复");
  await selectCard(allowed); await click("恢复");
  await until("explicit restoration", async () => (await detail(allowed)).deletedAt === null);
  check(true, "The recycle-bin entry restores only after the user's Restore action");
  await deleteViaUi(allowed);
  await stopSession(); await startSession();
  const reopened = await until("reopened target", () => invoke("plugin:library|current_library"));
  check(reopened.id === libraryId, "Restart reopens the same target library in the isolated data directory");
  await prepare(); text = await finishImport();
  check(text.includes("曾永久删除的同一内容已跳过") && (await browse()).total === 0, "Deletion memory survives explicit allow, deletion again, and a real process restart");

  writeFileSync(original, newBytes); metadata.size = newBytes.length; metadata.width = 310; metadata.height = 130; saveItem();
  await prepare(); await finishImport(); cards = await browse(); const changed = cards.cards[0].id;
  const changedDetail = await detail(changed);
  check(cards.total === 1 && changedDetail.width === 310 && changedDetail.height === 130, "New bytes of the same Eagle item import as a new content version");
  await deleteViaUi(changed);
  await prepare(); await clickXPath("//*[@aria-label='Eagle 重导选择']//label[contains(.,'允许本次重新导入')]/input");
  rmSync(original); text = await finishImport();
  check(text.includes("重试失败的 1 项") && (await browse()).total === 0, "An allowed import with a missing source reports a retryable read failure");
  writeFileSync(original, newBytes); await click("重试失败的 1 项"); await until("retry policy", policy);
  check(JSON.stringify(await defaultChecked()) === "[false,true]", "Failure retry retains this task's explicit allow choice and source");
  await screenshot("retry-keeps-choice"); await finishImport();
  check((await browse()).total === 1, "The repaired source retries successfully through the real wizard");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error);
  if (base) { try { writeFileSync(join(output, "failure.html"), await wd("GET", `${base}/source`)); await screenshot("failure"); } catch {} }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString(); writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  await stopSession();
  const actual = realpathSync(work), tempRoot = realpathSync(tmpdir());
  if (dirname(actual) === tempRoot && basename(actual).startsWith("kinshoko-spec78-t14-")) rmSync(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
