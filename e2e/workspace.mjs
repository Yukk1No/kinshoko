// #78 T07: formal workspace, detached provider, aggregation and global safety verification.
// Setup uses the same public Tauri actions as the UI; correspondence is corrected through rendered controls.
// Usage: node e2e/tag-identity.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, legacyArg] = process.argv;
if (!appArg || !edgeArg || !legacyArg) throw new Error("Usage: node e2e/workspace.mjs <kinshoko.exe> <msedgedriver.exe> <legacy-fixture-dir>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `workspace-${Date.now()}`);
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
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
const row = Buffer.from([0, 18, 28, 38, 18, 28, 38, 18, 28, 38]);
writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]));
const port = 4450;
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
  async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
  click(xpath) { return this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore" });
}

const legacyRoot = resolve(legacyArg);
const legacy = JSON.parse(readFileSync(join(legacyRoot, "legacy-fixture.json"), "utf8"));
const source = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4451", "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(legacyRoot, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
let first, second;
const scopeAll = { kind: "all" };
const blank = { conditions: [] };
const input = (...words) => ({ conditions: words.map((text) => ({ any: [{ kind: "text", text, dismissed: [] }], negate: false })), exact: true });
const browse = async (conditions = blank, scope = scopeAll, safeMode = true, limit = 100, cursor = null) => session.invoke("workspace_browse", { query: { scope, conditions, cursor, limit, thumbnailPx: 128 }, safeMode });
const resolveTree = (search, safeMode = true) => session.invoke("workspace_resolve", { input: search, lang: "zh-CN", safeMode });
const candidate = (text, safeMode = true) => session.invoke("workspace_candidates", { text, lang: "zh-CN", limit: 10, safeMode });
const uiTotal = (number) => until(`wall total ${number}`, () => session.exec("return document.querySelector('.wall')?.dataset.total === arguments[0];", [String(number)]));
const restart = async () => {
  if (session) await session.close(); session = null; quitOwnApp(); await delay(700);
  session = await Session.start();
};
function png(path, seed) {
  const header = Buffer.alloc(13); header.writeUInt32BE(120, 0); header.writeUInt32BE(90, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(361); row[0] = 0;
  for (let x = 0; x < 120; x++) { row[x * 3 + 1] = seed; row[x * 3 + 2] = 28; row[x * 3 + 3] = 38; }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 90 }, () => row)))), chunk("IEND", Buffer.alloc(0))]));
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  const oldStatus = await session.invoke("workspace_status", { safeMode: true });
  const oldProvider = oldStatus.libraries.find((r) => r.library.id === legacy.first.id);
  assert(oldProvider?.unavailable?.includes("升级"), "old detached provider explicitly needs upgrade instead of empty or silently upgraded");
  assert(oldStatus.libraries.find((r) => r.library.id === legacy.second.id)?.unavailable === null, "active startup library follows writable migration path");
  await until("old provider status rendered", () => session.exec("return [...document.querySelectorAll('.workspace-provider')].some(el => el.dataset.libraryId === arguments[0] && el.textContent.includes('暂时不可用'));", [legacy.first.id]));
  await session.screenshot("old-provider-needs-upgrade.png");
  await session.invoke("unregister_library", { libraryId: legacy.first.id });
  await session.invoke("unregister_library", { libraryId: legacy.second.id });
  const files = Array.from({ length: 24 }, (_, i) => { const path = join(work, `sample-${i}.png`); png(path, 18 + i); return path; });
  const near = join(work, "near-but-different.png"); png(near, 77);
  const create = async (name, paths) => {
    const info = await session.invoke("create_library", { parent: libraries, name });
    await session.invoke("start_import", { libraryId: info.id, source: { paths } });
    const page = await until(`import ${name}`, async () => {
      const page = await session.invoke("browse", { libraryId: info.id, query: { scope: scopeAll, conditions: blank, cursor: null, limit: 100, thumbnailPx: 128 } });
      return page.total === paths.length ? page : null;
    });
    return { info, page };
  };
  first = await create("工作区甲库", files);
  // Locate the byte identity through the public detail's original file names, never private SQL.
  const firstDetails = await Promise.all(first.page.cards.map(async c => [c.id, await session.invoke("image", { libraryId: first.info.id, imageId: c.id })]));
  const findSample = firstDetails.find(([, detail]) => JSON.stringify(detail).includes("sample-0.png"));
  if (!findSample) throw new Error("sample-0 detail unavailable");
  first.imageId = findSample[0];
  await session.invoke("edit_tags", { libraryId: first.info.id, imageIds: [first.imageId], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "蓝发", lang: "zh-CN" } }] });
  second = await create("工作区乙库", [files[0], near]);
  const secondDetails = await Promise.all(second.page.cards.map(async c => [c.id, await session.invoke("image", { libraryId: second.info.id, imageId: c.id })]));
  second.imageId = secondDetails.find(([, d]) => JSON.stringify(d).includes("sample-0.png"))[0];
  const secondUnique = secondDetails.find(([id]) => id !== second.imageId)[0];
  await session.invoke("edit_tags", { libraryId: second.info.id, imageIds: [second.imageId], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "短发", lang: "zh-CN" } }] });
  await session.invoke("edit_tags", { libraryId: second.info.id, imageIds: [secondUnique], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "离线专属词", lang: "zh-CN" } }] });
  await restart();
  await uiTotal(25);
  assert(await session.exec("return document.querySelector('[aria-label=\"查找范围\"] button[aria-current=page]')?.textContent === '全部资料库';"), "formal workspace defaults to all available registered providers");
  let page = await browse();
  assert(page.total === 25 && page.cards.filter(c => c.sources.length === 2).length === 1, "byte-identical files aggregate while similar pixels remain separate");
  assert(page.cards.every(c => !c.adult), "unknown-rating images remain visible in safe mode");
  let splitTree = await resolveTree(input("蓝发", "短发"));
  assert((await browse(splitTree)).total === 0, "complete per-source all query rejects split-tag false match");
  const blue = await resolveTree(input("蓝发"));
  const bluePage = await browse(blue);
  assert(bluePage.total === 1 && bluePage.cards[0].sources.length === 2 && bluePage.cards[0].sources.filter(s => s.matches).length === 1, "nonmatching known source remains inspectable");
  await session.invoke("switch_library", { libraryId: first.info.id });
  await session.invoke("edit_tags", { libraryId: first.info.id, imageIds: [first.imageId], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "短发", lang: "zh-CN" } }] });
  await session.invoke("switch_library", { libraryId: second.info.id });
  splitTree = await resolveTree(input("蓝发", "短发"));
  assert((await browse(splitTree)).total === 1, "one complete source makes aggregated card match");
  await until("workspace provider refresh", () => session.exec("return document.querySelector('.wall')?.dataset.total === '25';"));
  await session.click(`//nav[@aria-label='查找范围']//button[.//span[text()='工作区甲库']]`);
  await uiTotal(24);
  assert((await session.invoke("current_library")).id === second.info.id, "browse scope change does not switch active write target");
  const pair = (await browse(blank, { kind: "library", libraryId: first.info.id, scope: scopeAll })).cards.find(c => c.sources.length === 2);
  await session.exec("document.querySelector('.wall').scrollTop = 10000; document.querySelector('.wall').dispatchEvent(new Event('scroll')); ");
  await until("pair card rendered", () => session.find(`//*[@data-id='${pair.id}']//button[contains(.,'份来源')]`));
  await session.click(`//*[@data-id='${pair.id}']//button[contains(.,'份来源')]`);
  await until("formal sources dialog", () => session.find("//*[@role='dialog' and @aria-label='资料库来源']"));
  assert(await session.exec("const d=document.querySelector('[aria-label=\"资料库来源\"]'); return d.textContent.includes('工作区甲库') && d.textContent.includes('工作区乙库') && d.textContent.includes('不符合当前查找');"), "formal source controls show out-of-scope source independently");
  await session.screenshot("scope-and-all-sources.png");
  await session.click("//*[@aria-label='资料库来源']//li[strong[text()='工作区甲库']]//button[text()='查看此来源']");
  await until("detached viewer loaded", () => session.exec("const img=document.querySelector('.viewer img'); return img?.complete && img.naturalWidth > 0;"));
  assert((await session.invoke("current_library")).id === second.info.id, "nonactive source detail and image read leave active target unchanged");
  const viewerImage = await session.exec("return document.querySelector('.viewer img').src;");
  assert(viewerImage.includes(first.info.id) && viewerImage.includes(first.imageId), "viewer reads explicitly chosen source rather than hash card ID");
  await session.exec("document.querySelector('.viewer').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));");
  await until("Esc returns to wall", () => session.exec("return !document.querySelector('.viewer');"));
  assert(await session.exec("return document.querySelector('.wall').scrollTop > 0;"), "Esc keeps wall return position");
  await session.click("//nav[@aria-label='查找范围']//button[text()='全部资料库']");
  await uiTotal(25);
  const one = await browse(blank, scopeAll, true, 1);
  const two = await browse(blank, scopeAll, true, 1, one.nextCursor);
  assert(one.total === two.total && one.cards[0].id !== two.cards[0].id, "workspace page counts and opaque cursors are consistent");
  await session.invoke("set_safe_mode", { on: false });
  assert(await browse(blank, scopeAll, false, 1, one.nextCursor).then(() => false, () => true), "safe-mode revision rejects old page cursor");
  assert(await session.invoke("workspace_candidates", { text: "蓝", lang: "zh-CN", limit: 10, safeMode: true }).then(() => false, () => true), "mode mismatch rejects stale candidate action");
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.imageId], edits: [{ kind: "setRating", rating: "explicit" }] });
  await session.invoke("set_safe_mode", { on: true });
  await uiTotal(24);
  assert((await browse(blue, { kind: "library", libraryId: first.info.id, scope: scopeAll })).total === 0, "Adult in out-of-scope nonmatching source vetoes whole card");
  assert((await candidate("蓝发")).length === 0, "safe candidates/counts omit globally vetoed identity");
  assert(await session.invoke("workspace_image", { libraryId: first.info.id, imageId: first.imageId }).then(() => false, () => true), "detail read cannot bypass cross-source Adult veto");
  await session.screenshot("safe-cross-source-veto.png");
  await session.invoke("set_safe_mode", { on: false });
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.imageId], edits: [{ kind: "setRating", rating: "general" }] });
  await session.invoke("set_safe_mode", { on: true });
  await uiTotal(25);
  assert((await candidate("蓝发"))[0]?.count === 1, "rating refresh restores deduplicated candidate count");
  await session.invoke("set_safe_mode", { on: false });
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.imageId], edits: [{ kind: "setRating", rating: "explicit" }] });
  await session.invoke("set_safe_mode", { on: true });
  await browse(); // durably observe the Adult source before disconnect.
  await session.close(); session = null; quitOwnApp(); await delay(700);
  renameSync(second.info.root, second.info.root + ".offline");
  session = await Session.start();
  await uiTotal(23);
  const offline = await session.invoke("workspace_status", { safeMode: true });
  assert(Boolean(offline.libraries.find(r => r.library.id === second.info.id)?.unavailable), "unavailable registered provider has explicit state after restart");
  assert((await browse(blue)).total === 0, "known offline Adult veto survives full application restart");
  await session.invoke("set_safe_mode", { on: false });
  await uiTotal(24);
  const offlinePair = (await browse(blank, scopeAll, false)).cards.find(c => c.sources.length === 2);
  assert(offlinePair?.sources.some(s => s.unavailable && s.libraryId === second.info.id), "known offline source remains inspectable on available bytes");
  assert((await candidate("离线专属词", false)).length === 0, "unavailable provider cached definitions never enter candidates");
  await session.screenshot("offline-known-source.png");
  await session.invoke("set_safe_mode", { on: true });
  await session.invoke("unregister_library", { libraryId: second.info.id });
  await uiTotal(24);
  assert((await browse(blue)).total === 1, "explicit unregister removes conservative offline veto");
  await session.screenshot("workspace-after-unregister.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", source, binarySha256, application, legacySource: "22c60f248915329e4bf85dcfb38633210190f558", first, second, assertions, stories: [5, 9, 10, 11, 16, 44] }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", source, binarySha256, application, assertions, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
