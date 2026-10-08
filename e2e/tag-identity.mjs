// #78 T02: formal app inspection/correction with real libraries and a process restart.
// Setup uses the same public Tauri actions as the UI; correspondence is corrected through rendered controls.
// Usage: node e2e/tag-identity.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/tag-identity.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `tag-identity-${Date.now()}`);
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
const port = 4446;
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
function assert(ok, label) { if (!ok) throw new Error(label); console.log(`PASS ${label}`); }
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
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4447", "--native-driver", resolve(edgeArg)], { env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1" }, stdio: ["ignore", "inherit", "inherit"] });
let session;
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  const create = async (name, label) => {
    const info = await session.invoke("create_library", { parent: libraries, name });
    await session.invoke("start_import", { libraryId: info.id, source: { paths: [imagePath] } });
    const page = await until(`import ${name}`, async () => { const page = await session.invoke("browse", { libraryId: info.id, query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 20, thumbnailPx: 128 } }); return page.cards.length === 1 ? page : null; });
    const imageId = page.cards[0].id;
    await session.invoke("edit_tags", { libraryId: info.id, imageIds: [imageId], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: label, lang: "zh-CN" } }] });
    const vocabulary = await session.invoke("vocabulary", { libraryId: info.id });
    const localId = vocabulary.tags[0].id;
    await session.invoke("add_tag_alias", { libraryId: info.id, tagId: localId, alias: { name: "染发", lang: null } });
    return { info, imageId, localId };
  };
  const first = await create("第一库", "蓝发");
  const second = await create("第二库", "青丝");
  let snapshot = await session.invoke("inspect_tag_catalog");
  const target = snapshot.catalog.mappings.find((m) => m.libraryId === first.info.id).catalogId;
  const secondBefore = await session.invoke("image_tags", { libraryId: second.info.id, imageId: second.imageId, lang: "zh-CN" });
  assert(snapshot.catalog.tags.length === 2, "ambiguous aliases do not merge identities");
  assert(first.localId !== second.localId, "real libraries use different local IDs");
  await session.close(); session = null; quitOwnApp(); await delay(700);
  session = await Session.start();
  await until("main controls", () => session.find("//button[normalize-space()='设置']"));
  await session.click("//button[normalize-space()='设置']");
  await until("catalog controls", () => session.find("//button[normalize-space()='检查标签对应']"));
  await session.click("//button[normalize-space()='检查标签对应']");
  const row = `//tr[@data-library-id='${second.info.id}' and @data-local-tag-id='${second.localId}']`;
  await until("second-library correspondence row", () => session.find(row));
  await session.exec("const row = document.querySelector('[data-local-tag-id=\"' + arguments[0] + '\"]'); const select = row.querySelector('select'); select.value = arguments[1]; select.dispatchEvent(new Event('change', { bubbles: true }));", [second.localId, target]);
  await session.click(`${row}//button[normalize-space()='保存对应']`);
  await until("saved correction in rendered row", () => session.find(`${row}//*[contains(.,'已纠正')]`));
  await session.screenshot("corrected-correspondence.png");
  snapshot = await session.invoke("inspect_tag_catalog");
  assert(snapshot.catalog.mappings.find((m) => m.libraryId === second.info.id).catalogId === target, "formal controls persist corrected shared identity");
  const resolved = await session.invoke("catalog_image_tags", { libraryId: second.info.id, imageId: second.imageId, lang: "zh-CN" });
  assert(resolved.identities[0].catalogId === target && resolved.identities[0].tag.name === "蓝发", "tag identity display adopts correction");
  assert(JSON.stringify(resolved.image) === JSON.stringify(secondBefore), "legacy display and manual decision remain local");
  const candidates = await session.invoke("search_candidates", { libraryId: second.info.id, text: "蓝发", lang: "zh-CN", limit: 10, safeMode: true });
  assert(candidates.some((candidate) => candidate.tag.id === second.localId), "formal search resolves corrected shared definition to local ID");
  await session.invoke("switch_library", { libraryId: first.info.id });
  await session.invoke("edit_tags", { libraryId: first.info.id, imageIds: [first.imageId], edits: [{ kind: "reject", tag: { kind: "id", id: first.localId } }] });
  await session.invoke("switch_library", { libraryId: second.info.id });
  const afterOtherDecision = await session.invoke("image_tags", { libraryId: second.info.id, imageId: second.imageId, lang: "zh-CN" });
  assert(JSON.stringify(afterOtherDecision) === JSON.stringify(secondBefore), "other library's rejection does not change local image decision");
  await session.close(); session = null; quitOwnApp(); await delay(700);
  session = await Session.start();
  await until("reopened library", async () => (await session.invoke("current_library"))?.id === second.info.id);
  snapshot = await session.invoke("inspect_tag_catalog");
  assert(snapshot.catalog.mappings.find((m) => m.libraryId === second.info.id).catalogId === target, "correction survives full application restart");
  await session.click("//button[normalize-space()='设置']");
  await until("reopened catalog controls", () => session.find("//button[normalize-space()='检查标签对应']"));
  await session.click("//button[normalize-space()='检查标签对应']");
  await until("reopened rendered correspondence", () => session.find(`${row}//*[contains(.,'已纠正')]`));
  await session.screenshot("reopened-correspondence.png");
  await session.invoke("set_safe_mode", { on: false });
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.imageId], edits: [{ kind: "setRating", rating: "explicit" }] });
  await session.click("//button[normalize-space()='检查标签对应']");
  await until("unsafe correspondence visible for inspection", () => session.find(row));
  await session.invoke("set_safe_mode", { on: true });
  await until("mode change clears inspected records", () => session.exec("return !document.querySelector('[data-local-tag-id=\"' + arguments[0] + '\"]');", [second.localId]));
  assert(await session.invoke("image", { libraryId: second.info.id, imageId: second.imageId }).then(() => false, () => true), "inspection does not unseal the active library's image");
  snapshot = await session.invoke("inspect_tag_catalog");
  assert(!snapshot.catalog.mappings.some((mapping) => mapping.libraryId === second.info.id), "safe inspection omits sealed-image-only definitions");
  await session.screenshot("safe-mode-cleared-correspondence.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", application, first: first.info.id, second: second.info.id, target, stories: [17, 18] }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", application, error: String(error), stories: [17, 18] }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { stdio: "ignore" });
}
