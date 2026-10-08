// #78 T04: legacy v16 libraries, explicit name ownership, cancellation and conflicts.
// Setup uses public Tauri actions; preference, alias, library selection and search use rendered controls.
// Usage: node e2e/tag-names.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/tag-names.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `legacy-names-${Date.now()}`);
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
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4458);
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
  click(xpath) { return this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
  async set(xpath, value) {
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!element) throw Error('control missing'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, arguments[1]); element.dispatchEvent(new Event('input', { bubbles: true }));", [xpath, value]);
  }
  async select(xpath, value) { await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; element.value = arguments[1]; element.dispatchEvent(new Event('change', { bubbles: true }));", [xpath, value]); }
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
const driver = spawn(process.argv[4] ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1" }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let session;
const setting = "//button[@aria-label='设置' or normalize-space()='设置']";

const oldSchema = readFileSync("crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql", "utf8");
function oldLibrary(name, oldName) {
  const root = join(libraries, name);
  mkdirSync(root);
  const bytes = readFileSync(imagePath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const rel = `originals/${sha.slice(0, 2)}/${sha}.png`;
  mkdirSync(join(root, "originals", sha.slice(0, 2)), { recursive: true });
  writeFileSync(join(root, rel), bytes);
  const db = new DatabaseSync(join(root, "library.sqlite"));
  db.exec(oldSchema);
  const identity = (suffix) => createHash("sha256").update(name + suffix).digest("hex").slice(0, 32);
  const id = identity("library"), imageId = identity("image"), localId = identity("parted");
  db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id, name);
  db.prepare("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at) VALUES (?,?,?,'png',?,3,3,1,'old.png',1000)").run(imageId, sha, bytes.length, rel);
  db.prepare("INSERT INTO tag VALUES (?,'general',1000)").run(localId);
  db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(localId, oldName);
  db.prepare("INSERT INTO tag_external VALUES ('parted_hair',?)").run(localId);
  db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId, localId);
  db.prepare("INSERT INTO tag_decision VALUES (?,?,'add',1000)").run(imageId, localId);
  db.close();
  return { info: { id, root, name }, imageId, localId, original: join(root, rel), sha };
}
const first = oldLibrary("旧名称第一库", "分发");
const second = oldLibrary("旧名称第二库", "分开的头发");
let target;
async function register(library) {
  const info = await session.invoke("register_library", { root: library.info.root });
  assert(info.id === library.info.id, `opens released v16 ${info.name} with stable library identity`);
  await until("current library", async () => (await session.invoke("current_library"))?.id === info.id);
  await restart();
}
async function migration() { return session.invoke("plan_legacy_names"); }
async function openWizard() {
  if (!await session.exec("return Boolean(document.querySelector('[role=dialog][aria-label=程序设置]'))")) {
    await until("old-name notice", () => session.find("//button[normalize-space()='查看旧名称迁移']"));
    await session.click("//button[normalize-space()='查看旧名称迁移']");
  } else {
    const button = await session.exec("return [...document.querySelectorAll('button')].find((node) => ['迁移旧库名称','重新读取迁移记录'].includes(node.textContent.trim()))?.textContent.trim()");
    if (button) await session.click(`//button[normalize-space()='${button}']`);
  }
  await until("migration choice", () => session.find("//select[@aria-label='名称归属']"));
  await session.exec("document.querySelector('.legacy-name-migration').scrollIntoView({ block: 'start' })");
}
async function chooseLegacy(library) {
  const value = await session.exec("const select = document.querySelector('select[aria-label=名称归属]'); return [...select.options].find((option) => option.textContent.includes(arguments[0]) && option.value.startsWith('legacy:')).value", [library.info.name]);
  await session.select("//select[@aria-label='名称归属']", value);
}
async function confirm() {
  await until("complete core preview before confirmation", () => session.exec("return [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === '确认本批次名称归属' && !node.disabled)"));
  await session.click("//button[normalize-space()='确认本批次名称归属']");
  await until("saved migration", () => session.exec("return document.body.textContent.includes('本批次名称归属已保存。')"));
}
async function closeSettings() { await session.click("//button[normalize-space()='关闭设置']"); }
async function tags(library) { return session.invoke("image_tags", { libraryId: library.info.id, imageId: library.imageId, lang: "zh-CN" }); }
async function displayed(library, expected) {
  await session.select("//select[@aria-label='当前资料库']", library.info.id);
  await until("selected library and wall", async () => (await session.invoke("current_library"))?.id === library.info.id && await session.find(`//*[@data-id='${library.imageId}']`));
  await session.controlClick(`//*[@data-id='${library.imageId}']`);
  await until("rendered image label", () => session.exec("return [...document.querySelectorAll('.tag-panel .tag-name')].some((node) => node.textContent === arguments[0]);", [expected]));
  const value = await tags(library);
  assert(value.tags[0].tag.id === library.localId && value.tags[0].origins.some((origin) => origin.kind === "manual"), `${library.info.name} retains local ID and manual decision while displaying ${expected}`);
}
async function restart() {
  await session.close(); session = null; quitOwnApp(); await delay(700);
  session = await Session.start();
  await until("restored main controls", () => session.find(setting));
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await register(first); await register(second);
  let plan = await migration();
  target = plan.plan.groups[0].catalogId;
  assert(plan.plan.groups.length === 1 && plan.plan.groups[0].sources.length === 2, "one shared identity explicitly lists both old library names");
  await displayed(first, "分发"); await displayed(second, "分开的头发");
  await openWizard();
  assert(await session.exec("return document.body.textContent.includes('分发') && document.body.textContent.includes('分开的头发') && document.body.textContent.includes('同一统一标签存在不同旧名称')"), "formal wizard lists different old names and their stable identity mapping");
  await session.select("//select[@aria-label='名称归属']", "default");
  await session.screenshot("formal-legacy-conflict-cancel.png");
  await session.click("//button[normalize-space()='取消迁移']");
  assert((await migration()).plan.groups[0].sources.length === 2 && !(await session.invoke("inspect_tag_catalog")).catalog.tags.find((tag) => tag.id === target).namePreferences.length, "cancel persists no ownership or preference");
  await closeSettings(); await restart();
  await displayed(first, "分发"); await displayed(second, "分开的头发");
  await openWizard(); await chooseLegacy(second);
  await session.screenshot("formal-legacy-preference-preview.png");
  await confirm(); await closeSettings();
  await displayed(first, "分开的头发"); await displayed(second, "分开的头发");
  await restart();
  assert((await migration()).plan.groups.length === 0, "confirmed sources remain resolved across full restart");
  const third = oldLibrary("旧名称第三库", "分缝发型");
  await register(third);
  plan = await migration();
  assert(plan.plan.groups[0].sources.length === 1 && plan.plan.groups[0].existingPreference === "分开的头发" && plan.plan.groups[0].sources[0].legacyName === "分缝发型" && plan.plan.groups[0].sources[0].currentName === "分开的头发", "later old library still exposes its old-name conflict while global preference stays highest priority");
  await openWizard();
  await session.screenshot("formal-existing-preference-conflict.png");
  await session.select("//select[@aria-label='名称归属']", "default");
  assert(await session.exec("return document.body.textContent.includes('将撤回“分开的头发”的全局偏好')"), "follow-default preview explicitly explains removal of the existing global preference");
  await confirm(); await closeSettings();
  await displayed(first, "分缝发型"); await displayed(third, "分缝发型");
  assert(!(await session.invoke("inspect_tag_catalog")).catalog.tags.find((tag) => tag.id === target).namePreferences.length, "follow-default deletes the explicit preference");
  const fourth = oldLibrary("旧名称第四库", "分缝发型");
  await register(fourth); await openWizard(); await chooseLegacy(fourth); await confirm();
  const shared = (await session.invoke("inspect_tag_catalog")).catalog.tags.find((tag) => tag.id === target);
  assert(shared.namePreferences.some((name) => name.lang === "zh-CN" && name.name === "分缝发型"), "keeping an old name equal to the current default saves an explicit preference");
  assert(shared.aliases.some((alias) => alias.name === "分发") && shared.aliases.some((alias) => alias.name === "分开的头发"), "replaced old names remain separate removable aliases");
  await session.screenshot("formal-equal-default-explicit-choice.png");
  await closeSettings(); await restart();
  assert((await migration()).plan.groups.length === 0, "repeat opening does not repeat or overwrite confirmed choices");
  for (const library of [first, second, third, fourth]) assert(createHash("sha256").update(readFileSync(library.original)).digest("hex") === library.sha, `${library.info.name} keeps original file bytes`);
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", application, stories: [25,26], assertions, target, first, second, third, fourth, environment: await session.exec("return { userAgent: navigator.userAgent, dpr: devicePixelRatio, width: innerWidth, height: innerHeight }") }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", application, error: String(error), assertions, stories: [25,26] }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
