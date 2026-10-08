// #78 T03: formal global names, aliases and search in two real libraries, with restarts.
// Setup uses public Tauri actions; preference, alias, library selection and search use rendered controls.
// Usage: node e2e/tag-names.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/tag-names.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `tag-names-${Date.now()}`);
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
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4450);
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
let first, second, target;
async function openNames() {
  await until("settings button", () => session.find(setting));
  await session.click(setting);
  await until("name management controls", () => session.find("//button[normalize-space()='管理显示名称']"));
  await session.click("//button[normalize-space()='管理显示名称']");
  await until("name selector", () => session.find("//select[@aria-label='选择标签']"));
  await session.select("//select[@aria-label='选择标签']", target);
  await until("selected name editor", () => session.find(`//tr[@data-catalog-name-id='${target}']`));
}
const nameRow = () => `//tr[@data-catalog-name-id='${target}']`;
async function savePreference(value) {
  await session.set(`${nameRow()}//input[contains(@aria-label,'偏好名称')]`, value);
  await session.click(`${nameRow()}//button[normalize-space()='保存偏好']`);
  await until("saved explicit preference", async () => {
    const snapshot = await session.invoke("inspect_tag_catalog");
    const lang = await session.exec("return document.querySelector('input[aria-label=名称语言]').value");
    return snapshot.catalog.tags.find((tag) => tag.id === target)?.namePreferences.some((name) => name.lang === lang && name.name === value);
  });
}
async function switchRendered(library) {
  await session.select("//select[@aria-label='当前资料库']", library.info.id);
  await until("selected library and wall", async () => (await session.invoke("current_library"))?.id === library.info.id && await session.find(`//*[@data-id='${library.imageId}']`));
}
async function displayed(library, expected) {
  await switchRendered(library);
  await session.controlClick(`//*[@data-id='${library.imageId}']`);
  await until("rendered image label", () => session.exec("return [...document.querySelectorAll('.tag-panel .tag-name')].some((node) => node.textContent === arguments[0]);", [expected]));
  assert(true, `${library.info.name} displays ${expected} in the actual tag panel`);
}
async function searchRendered(text, expectedCandidate, expectedCount) {
  await session.set("//input[@aria-label='查找参考图']", text);
  await session.click("//input[@aria-label='查找参考图']");
  if (expectedCandidate) await until("rendered alias candidate", () => session.exec("return [...document.querySelectorAll('.search-candidate-name')].some((node) => node.textContent === arguments[0]);", [expectedCandidate]));
  else await until("removed alias has no candidate", () => session.invoke("search_candidates", { libraryId: second.info.id, text, lang: "zh-CN", limit: 10, safeMode: true }).then((value) => value.length === 0));
  await session.key(String.fromCharCode(0xE007));
  await until("rendered search results", () => session.exec("return document.querySelector('[aria-label=查找结果]')?.textContent === arguments[0];", [`${expectedCount} 张`]));
  assert(true, `formal search for ${text} returns ${expectedCount} image(s) with ${expectedCandidate ?? "no tag candidate"}`);
}
async function restart() {
  await session.close(); session = null; quitOwnApp(); await delay(700);
  session = await Session.start();
  await until("restored main controls", () => session.find(setting));
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  const create = async (name, label, longHair = false) => {
    const info = await session.invoke("create_library", { parent: libraries, name });
    await session.invoke("start_import", { libraryId: info.id, source: { paths: [imagePath] } });
    const page = await until(`import ${name}`, async () => { const page = await session.invoke("browse", { libraryId: info.id, query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 20, thumbnailPx: 128 } }); return page.cards.length === 1 ? page : null; });
    const imageId = page.cards[0].id;
    await session.invoke("edit_tags", { libraryId: info.id, imageIds: [imageId], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: label, lang: "zh-CN" } }] });
    let vocabulary = await session.invoke("vocabulary", { libraryId: info.id });
    const localId = vocabulary.tags[0].id;
    await session.invoke("map_tag_external", { libraryId: info.id, tagId: localId, external: "parted_hair" });
    if (longHair) await session.invoke("edit_tags", { libraryId: info.id, imageIds: [imageId], edits: [{ kind: "add", tag: { kind: "external", namespace: "general", name: "long_hair_between_eyes" } }] });
    return { info, imageId, localId };
  };
  first = await create("名称第一库", "分发", true);
  second = await create("名称第二库", "分开的头发");
  let snapshot = await session.invoke("inspect_tag_catalog");
  target = snapshot.catalog.mappings.find((mapping) => mapping.localTagId === first.localId).catalogId;
  assert(first.localId !== second.localId && snapshot.catalog.mappings.find((mapping) => mapping.localTagId === second.localId).catalogId === target, "two real libraries use distinct local IDs for one shared identity");
  assert(snapshot.catalog.tags.some((tag) => tag.names.some((name) => name.name === "两眼间长发")), "accepted long_hair_between_eyes default reaches formal app");
  await restart();
  await openNames();
  await savePreference("分缝发型");
  assert(true, "saving text equal to the default creates an explicit persisted preference");
  await session.set("//input[@aria-label='名称语言']", "en");
  await savePreference("Hair parted in the middle");
  await session.set("//input[@aria-label='名称语言']", "zh-CN");
  await savePreference("自然分缝");
  await session.screenshot("formal-name-preferences.png");
  await session.click("//button[normalize-space()='关闭设置']");
  await displayed(second, "自然分缝");
  await searchRendered("分发", "自然分缝", 1);
  await displayed(first, "自然分缝");
  await searchRendered("自然分缝", "自然分缝", 1);
  await session.screenshot("formal-first-library-search.png");
  await restart();
  snapshot = await session.invoke("inspect_tag_catalog");
  const tag = snapshot.catalog.tags.find((tag) => tag.id === target);
  assert(tag.namePreferences.some((name) => name.lang === "zh-CN" && name.name === "自然分缝") && tag.namePreferences.some((name) => name.lang === "en" && name.name === "Hair parted in the middle"), "independent language preferences survive full application restart");
  await openNames();
  await session.click(`${nameRow()}//button[normalize-space()='恢复默认']`);
  await until("reset preference", async () => !(await session.invoke("inspect_tag_catalog")).catalog.tags.find((tag) => tag.id === target).namePreferences.some((name) => name.lang === "zh-CN"));
  snapshot = await session.invoke("inspect_tag_catalog");
  assert(snapshot.catalog.tags.find((tag) => tag.id === target).namePreferences.some((name) => name.lang === "en"), "reset deletes only Chinese preference and retains English preference");
  await session.click(`${nameRow()}//button[@aria-label='去掉别名“分发”']`);
  await until("alias removed", async () => !(await session.invoke("inspect_tag_catalog")).catalog.tags.find((tag) => tag.id === target).aliases.some((alias) => alias.name === "分发"));
  await session.set(`${nameRow()}//input[contains(@aria-label,'新别名')]`, "中间发缝");
  await session.click(`${nameRow()}//button[normalize-space()='加别名']`);
  await until("alias added", async () => (await session.invoke("inspect_tag_catalog")).catalog.tags.find((tag) => tag.id === target).aliases.some((alias) => alias.name === "中间发缝"));
  await session.screenshot("formal-default-and-aliases.png");
  await session.click("//button[normalize-space()='关闭设置']");
  await displayed(second, "分缝发型");
  await searchRendered("中间发缝", "分缝发型", 1);
  await displayed(first, "分缝发型");
  await searchRendered("中间发缝", "分缝发型", 1);
  await switchRendered(second);
  await restart();
  snapshot = await session.invoke("inspect_tag_catalog");
  assert(!snapshot.catalog.tags.find((tag) => tag.id === target).aliases.some((alias) => alias.name === "分发"), "deleted old alias stays deleted after bundled-table reinstallation on restart");
  await searchRendered("分发", null, 0);
  await session.screenshot("formal-removed-alias-search.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", application, stories: [19,20,21,22,23,24,27], assertions, first, second, target, environment: await session.exec("return { userAgent: navigator.userAgent, dpr: devicePixelRatio, width: innerWidth, height: innerHeight }") }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", application, error: String(error), assertions, stories: [19,20,21,22,23,24,27] }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, windowsHide: true, stdio: "ignore" });
}
