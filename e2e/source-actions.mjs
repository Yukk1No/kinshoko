// #78 T09: explicit per-provider curation, pins and reference groups in the formal application.
// Setup uses public Tauri actions; curation uses the rendered explicit-source controls.
// Usage: node e2e/source-actions.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/source-actions.mjs <owned kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `source-actions-${Date.now()}`);
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
const port = 4570;
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
  click(xpath) { return this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore" });
}

const appData = join(work, "app-data");
const source = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4571", "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: appData, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session, a, b, target, groupId, pin, environment;
const blank = { conditions: [] };
const query = { scope: { kind: "all" }, conditions: blank, cursor: null, limit: 100, thumbnailPx: 128 };
const browse = () => session.invoke("workspace_browse", { query, safeMode: true });
const inspect = (sourceTarget = target, safeMode = true) => session.invoke("workspace_source_inspection", { target: sourceTarget, safeMode, lang: "zh-CN" });
const uiTotal = (total) => until(`wall total ${total}`, () => session.exec("return document.querySelector('.wall')?.dataset.total === arguments[0];", [String(total)]));
const stopApp = async () => {
  if (session) await session.close().catch(() => {});
  session = null; quitOwnApp(); await delay(800);
};
const restart = async () => { await stopApp(); session = await Session.start(); await uiTotal(1); await delay(1800); };
const openSource = async (libraryId) => {
  await until("source card", () => session.find("//*[@data-id]//button[contains(.,'份来源')]"));
  await session.click("//*[@data-id]//button[contains(.,'份来源')]");
  await session.click(`//*[@data-source-library-id='${libraryId}']//button[text()='整理此来源']`);
  await until("source note ready", () => session.find("//*[@aria-label='整理来源']//textarea"));
};
const closeSources = async () => { await session.click("//button[text()='关闭来源']"); await delay(200); };
const pinState = () => JSON.parse(readFileSync(join(appData, "pins.json"), "utf8")).pins;
const stableReference = (value) => value.libraryId === target.libraryId && value.imageId === target.imageId;
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  environment = await session.exec("return { userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };" );
  const create = async (parent, tag, note) => {
    mkdirSync(parent);
    const info = await session.invoke("create_library", { parent, name: "同名资料库" });
    await session.invoke("start_import", { libraryId: info.id, source: { paths: [imagePath] } });
    const page = await until("initial import", async () => {
      const value = await session.invoke("browse", { libraryId: info.id, query });
      return value.total === 1 ? value : null;
    });
    const imageId = page.cards[0].id;
    const folderId = await session.invoke("create_folder", { libraryId: info.id, name: tag + "目录", parent: null });
    await session.invoke("edit", { libraryId: info.id, ids: [imageId], edits: [{ kind: "setNote", text: note }, { kind: "addToFolder", folderId }] });
    await session.invoke("edit_tags", { libraryId: info.id, imageIds: [imageId], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: tag, lang: "zh-CN" } }] });
    return { ...info, imageId, folderId };
  };
  a = await create(join(libraries, "first"), "A 独立标签", "A 独立备注");
  b = await create(join(libraries, "second"), "B 独立标签", "B 独立备注");
  await session.invoke("switch_library", { libraryId: a.id });
  await restart();
  let page = await browse();
  assert(page.cards.length === 1 && page.cards[0].sources.length === 2, "same bytes aggregate across two independently curated providers");
  target = { libraryId: b.id, imageId: b.imageId, contentId: page.cards[0].id };
  const aTarget = { libraryId: a.id, imageId: a.imageId, contentId: target.contentId };
  const aBefore = await inspect(aTarget);
  await session.click("//*[@data-id]//button[contains(.,'份来源')]");
  assert(await session.exec("return [...document.querySelectorAll('[data-source-library-id]')].map(el => el.textContent).join('|').includes('first') && [...document.querySelectorAll('[data-source-library-id]')].map(el => el.textContent).join('|').includes('second');"), "same-name source choices visibly show distinct path suffixes");
  await session.screenshot("same-name-source-choices.png");
  await session.click(`//*[@data-source-library-id='${b.id}']//button[text()='整理此来源']`);
  await until("B note", () => session.exec("return document.querySelector('[aria-label=\"整理来源\"] textarea')?.value === 'B 独立备注';"));
  await session.screenshot("explicit-inactive-source-before.png");
  await session.type("//*[@aria-label='整理来源']//textarea", "B 改后的独立备注");
  await session.click("//button[text()='保存备注']");
  await until("B note persisted", async () => (await inspect()).detail.note.manual === "B 改后的独立备注");
  assert((await inspect(aTarget)).detail.note.manual === "A 独立备注", "editing inactive B note leaves A note unchanged");
  assert((await session.invoke("current_library")).id === a.id, "source edits do not activate B or change current library");
  await until("source still open after real revision", () => session.find("//*[@aria-label='整理来源']//textarea"));
  await delay(1800);
  assert(await session.exec("return !!document.querySelector('[aria-label=\"整理来源\"] textarea');"), "workspace notification does not interrupt the revalidated explicit source editor");
  await session.exec("const select=document.querySelector('[aria-label=\"内容分级\"]'); select.value='sensitive'; select.dispatchEvent(new Event('change',{bubbles:true}));");
  await until("B rating", async () => (await inspect()).detail.rating.manual === "sensitive");
  assert((await inspect(aTarget)).detail.rating.manual === null, "B manual rating remains independent from A");
  await until("B folder control", () => session.find("//button[text()='移出「B 独立标签目录」']"));
  await session.click("//button[text()='移出「B 独立标签目录」']");
  await until("B folder removed", async () => (await inspect()).detail.folders.length === 0);
  assert((await inspect(aTarget)).detail.folders[0].id === a.folderId, "removing B folder membership preserves A folder membership");
  await session.exec("const select=document.querySelector('[aria-label=\"放入文件夹\"]'); select.value=arguments[0]; select.dispatchEvent(new Event('change',{bubbles:true}));", [b.folderId]);
  await until("B folder restored", async () => (await inspect()).detail.folders.some(f => f.id === b.folderId));
  await session.type("//*[@aria-label='标签名']", "B 新人工标签");
  await session.click("//button[text()='添加标签']");
  await until("B new tag", async () => (await inspect()).tags.image.tags.some(t => t.tag.name === "B 新人工标签"));
  assert(!(await inspect(aTarget)).tags.image.tags.some(t => t.tag.name === "B 新人工标签"), "new B manual tag never changes A tags");
  assert((await session.invoke("workspace_source_candidates", { target, safeMode: true, text: "B 新", lang: "zh-CN" }))[0]?.tag.name === "B 新人工标签", "source picker uses B local tag identities through actual native ACL");
  await until("B controls ready", () => session.find("//button[text()='钉住此来源']"));
  await session.screenshot("explicit-inactive-source-after.png");
  await session.click("//button[text()='钉住此来源']");
  await until("B pin saved", () => { pin = pinState().find(p => stableReference(p.content)); return pin; });
  assert(stableReference(pin.content), "direct pin saves the explicitly chosen inactive library/image identity");
  await session.type("//*[@aria-label='新参考组名称']", "T09 指定 B 来源");
  await session.click("//button[text()='加入参考组']");
  const groups = await until("source group created", async () => {
    const groups = await session.desktop("reference_groups"); return groups.some(g => g.name === "T09 指定 B 来源") ? groups : null;
  });
  groupId = groups.find(g => g.name === "T09 指定 B 来源").id;
  const groupBefore = (await session.desktop("reference_group", { groupId })).group;
  assert(groupBefore.members.length === 1 && stableReference(groupBefore.members[0]), "direct source group contains only B original reference");
  await session.screenshot("source-pin-and-group.png");
  await closeSources();
  await session.click(`//nav[@aria-label='查找范围']//*[@data-library-id='${a.id}']/div[contains(@class,'workspace-provider-root')]/button[contains(@class,'sidebar-item')]`);
  await uiTotal(1);
  assert(stableReference((await session.desktop("reference_group", { groupId })).group.members[0]) && stableReference(pinState()[0].content), "requery and default-scope changes do not relink saved B references to A");
  await stopApp();
  renameSync(b.root, b.root + ".offline");
  session = await Session.start(); await uiTotal(1); await delay(1800);
  const offlineGroup = await session.desktop("reference_group", { groupId });
  assert(stableReference(offlineGroup.group.members[0]) && offlineGroup.members[0].state.kind === "unavailable", "restart with disconnected B keeps B group member and reports unavailable instead of binding A");
  assert(stableReference(pinState()[0].content), "restart preserves the unavailable pin source identity");
  assert(await inspect().then(() => false, e => String(e).includes("暂时不可用")), "disconnected source inspection explicitly rejects B");
  assert(await session.invoke("workspace_edit_source", { target, safeMode: true, edits: [{ kind: "delete" }] }).then(() => false, e => String(e).includes("暂时不可用")), "disconnected B write never falls back to available A bytes");
  assert(JSON.stringify((await inspect(aTarget)).detail) === JSON.stringify(aBefore.detail), "A curation remains unchanged after B edits and disconnected requests");
  await session.screenshot("disconnected-source-keeps-reference.png");
  await stopApp(); renameSync(b.root + ".offline", b.root); session = await Session.start(); await uiTotal(1); await delay(1800);
  assert((await session.invoke("current_library")).id === a.id, "source editing and restart preserve last-opened A");
  assert((await inspect()).detail.note.manual === "B 改后的独立备注", "B independent curation persists across process restarts");
  await openSource(b.id);
  await session.click("//*[@aria-label='已选参考图']//button[text()='删除']");
  await until("B in trash", async () => (await inspect()).detail.deletedAt !== null);
  assert((await browse()).total === 1 && (await inspect(aTarget)).detail.deletedAt === null, "deleting B leaves aggregate A card and A original live");
  await delay(1800); await openSource(b.id);
  await session.click("//button[text()='永久删除…']");
  await until("B delete preview", () => session.find("//*[@role='alertdialog' and @aria-label='永久删除']"));
  assert(await session.exec("return document.querySelector('[role=alertdialog]').textContent.includes('T09 指定 B 来源');"), "inactive-source permanent-delete preview reports B reference-group impact");
  await session.screenshot("source-permanent-delete-preview.png");
  await session.click("//button[text()='确认永久删除']");
  await until("B permanent removal", () => inspect().then(() => false, () => true));
  assert((await browse()).total === 1 && (await inspect(aTarget)).detail.deletedAt === null, "permanent B deletion preserves A duplicate and its curation");
  const missingGroup = await session.desktop("reference_group", { groupId });
  assert(stableReference(missingGroup.group.members[0]) && missingGroup.members[0].state.kind === "unavailable", "permanent deletion retains B member identity and reports image missing");
  assert(await session.invoke("workspace_edit_source", { target: { ...aTarget, contentId: "stale-byte-identity" }, safeMode: true, edits: [{ kind: "delete" }] }).then(() => false, e => String(e).includes("来源")), "changed byte identity is rejected instead of targeting a current aggregate card");
  await session.invoke("set_safe_mode", { on: false });
  assert(await session.invoke("workspace_edit_source", { target: aTarget, safeMode: true, edits: [{ kind: "delete" }] }).then(() => false, e => String(e).includes("安全模式")), "stale safe-mode generation is rejected at the native write boundary");
  await session.invoke("set_safe_mode", { on: true });
  await session.screenshot("after-source-deletion.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", source, binarySha256, application, environment, a, b, target, groupId, pin, assertions, stories: [12, 13], finishedAt: new Date().toISOString() }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error); if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", source, binarySha256, application, environment, a, b, target, groupId, assertions, error: String(error) }, null, 2)); process.exitCode = 1;
} finally {
  await stopApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
