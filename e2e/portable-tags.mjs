// #78 T11: native portable definitions, library-copy and reference-package acceptance.
// Fixture creation uses public IPC. Corrections, preferences, aliases, publication, package
// export/import and group opening use rendered controls. Only the file-picker result is queued.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync, inflateRawSync } from "node:zlib";

const [, , appArg, edgeArg, driverArg] = process.argv;
if (!appArg || !edgeArg) throw Error("Usage: node e2e/portable-tags.mjs <owned kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const application = resolve(appArg);
const work = resolve("work/e2e", `portable-tags-${Date.now()}`);
mkdirSync(work, { recursive: true });
const port = 4568;
const url = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const build = JSON.parse(readFileSync("work/e2e/t11-build-source.json", "utf8").replace(/^\uFEFF/, ""));
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
  if (session) await session.close().catch(() => {});
  session = null; quitOwnApp();
  if (driver?.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  driver = null; await delay(450);
}
async function launch(name, profile, fault = false) {
  await stop(); phase = name; dataDir = join(work, profile); mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, KINSHOKO_DATA_DIR: dataDir, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, `webview-${name}`), KINSHOKO_FAULT: fault ? "portable_tags_publish_row@1" : "", KINSHOKO_FAULT_ACTION: fault ? "error" : "" };
  driver = spawn(driverArg ?? "tauri-driver", ["--port", String(port), "--native-port", "4569", "--native-driver", resolve(edgeArg)], { env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
  await until("driver ready", () => fetch(url + "/status").then((r) => r.ok));
  session = await Session.start();
  environments.push({ phase, dataDir, ...(await session.exec("return { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent };")) });
}
function png(path, seed) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff; for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(120); header.writeUInt32BE(90, 4); header[8] = 8; header[9] = 2;
  const rows = Array.from({ length: 90 }, (_, y) => { const row = Buffer.alloc(361); for (let x = 0; x < 120; x++) { row[x * 3 + 1] = (seed + x) % 256; row[x * 3 + 2] = y * 2; row[x * 3 + 3] = 38; } return row; });
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]));
}
function zipEntries(path) {
  const bytes = readFileSync(path), entries = new Map();
  for (let at = 0; at + 46 <= bytes.length; at++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) continue;
    const method = bytes.readUInt16LE(at + 10), size = bytes.readUInt32LE(at + 20), nameLength = bytes.readUInt16LE(at + 28), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), body = bytes.subarray(start, start + size);
    entries.set(name, method === 0 ? body : inflateRawSync(body));
    at += 45 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
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
  await session.invoke("start_import", { libraryId: info.id, source: { paths } });
  const page = await until("ordinary import " + name, async () => { const p = await session.invoke("browse", { libraryId: info.id, query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 } }); return p.cards.length === paths.length ? p : null; });
  const images = page.cards.map((c) => c.id);
  await session.invoke("edit_tags", { libraryId: info.id, imageIds: images, edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "白", lang: "zh-CN" } }] });
  const local = (await session.invoke("vocabulary", { libraryId: info.id })).tags.find((t) => t.names.some((n) => n.name === "白")).id;
  await session.refresh(info.id);
  return { info, images, local };
}
async function groupsPane() { if (!await session.exec("return document.querySelector('button[aria-label=参考组]')?.getAttribute('aria-expanded') === 'true';")) await session.click("//button[@aria-label='参考组']"); await until("groups pane", () => session.find("//input[@aria-label='新参考组名称']")); }
async function exportRendered(group, path) { await session.pick(path); await session.click(`//li[@class='reference-group' and @data-id='${group.id}']//button[normalize-space()='导出参考组包']`); await until("real exported ZIP", () => existsSync(path)); }
async function importRendered(path) {
  const before = new Set((await session.invoke("reference_groups", {}, "desktop")).map((g) => g.id));
  await session.pick(path); await session.click("//button[normalize-space()='导入参考组包']");
  return until("real imported group", async () => { const groups = await session.invoke("reference_groups", {}, "desktop"); const group = groups.find((g) => !before.has(g.id)); return group ? (await session.invoke("reference_group", { groupId: group.id }, "desktop")).group : null; });
}
async function pin(library, image, crop) {
  const prior = existsSync(join(dataDir, "pins.json")) ? JSON.parse(readFileSync(join(dataDir, "pins.json"), "utf8")).pins.map((p) => p.id) : [];
  await session.invoke("pin_reference", { libraryId: library.id, imageId: image, crop, shown: { x: 300, y: 220, width: 240, height: 180 } }, "desktop");
  return until("real persisted pin", () => { if (!existsSync(join(dataDir, "pins.json"))) return null; return JSON.parse(readFileSync(join(dataDir, "pins.json"), "utf8")).pins.find((p) => !prior.includes(p.id)); });
}
const portablePath = join(work, "portable.kinshoko-group");
let sourceA, sourceB, sourceIdentity, splitIdentity, sourceGroup, manifest, copiedA, copiedB, freshTarget, existingTarget;
try {
  const paths = ["a1", "a2", "b", "existing"].map((name, i) => { const p = join(work, name + ".png"); png(p, 18 + i * 40); return p; });
  await launch("source", "source-app");
  sourceA = await create("便携来源甲", paths.slice(0, 2));
  await session.invoke("map_tag_external", { libraryId: sourceA.info.id, tagId: sourceA.local, external: "t11_portable_white" });
  await session.invoke("edit", { libraryId: sourceA.info.id, ids: [sourceA.images[0]], edits: [{ kind: "setNote", text: "原图构图备注" }] });
  sourceB = await create("便携来源乙", [paths[2]]);
  let view = await catalog(); sourceIdentity = mapping(view, sourceA.info.id, sourceA.local).catalogId;
  assert(mapping(view, sourceB.info.id, sourceB.local).catalogId !== sourceIdentity, "same display names initially retain distinct global identities");
  assert(await correct(sourceB.info, sourceB.local, sourceIdentity) === sourceIdentity, "rendered correction explicitly joins two local IDs to one global identity");
  splitIdentity = await correct(sourceB.info, sourceB.local, "separate");
  assert(splitIdentity !== sourceIdentity, "rendered split creates another stable identity despite the same display name");
  await prefer(sourceIdentity, "源程序专用显示"); await alias(sourceIdentity, "雪"); await publish(sourceA.info.name); await closeSettings();
  const firstPin = await pin(sourceA.info, sourceA.images[0], { x: 10, y: 12, width: 50, height: 40 });
  await session.invoke("turn_pin", { pin: firstPin.id, turn: "flipHorizontal" }, "desktop"); await session.invoke("turn_pin", { pin: firstPin.id, turn: "rotateClockwise" }, "desktop");
  await session.invoke("zoom_pin", { pin: firstPin.id, scale: 1.5, anchorX: 300, anchorY: 220 }, "desktop"); await session.invoke("move_pin", { pin: firstPin.id, x: 310, y: 240 }, "desktop");
  await pin(sourceA.info, sourceA.images[1], null); await pin(sourceB.info, sourceB.images[0], { x: 4, y: 5, width: 70, height: 60 });
  await groupsPane(); await session.set("//input[@aria-label='新参考组名称']", "便携布局验收"); await session.click("//button[normalize-space()='把桌面钉图存为参考组']");
  sourceGroup = await until("saved real pins", async () => { const groups = await session.invoke("reference_groups", {}, "desktop"); const g = groups.find((g) => g.name === "便携布局验收"); return g ? (await session.invoke("reference_group", { groupId: g.id }, "desktop")).group : null; });
  assert(sourceGroup.members.length === 3, "rendered save captures all three real reference pins");
  const transformed = sourceGroup.members.find((m) => m.libraryId === sourceA.info.id && m.imageId === sourceA.images[0]);
  assert(transformed.crop.x === 10 && transformed.crop.y === 12 && transformed.crop.width === 50 && transformed.crop.height === 40 && transformed.placement.flipH && transformed.placement.rotation === 1 && transformed.placement.scale === 1.5 && transformed.placement.x === 310 && transformed.placement.y === 240, "saved source group contains the specified original-pixel crop and requested native pin transforms");
  await session.screenshot("01-source-group.png");
  await launch("publication-failure", "source-app", true);
  await alias(sourceIdentity, "白雪新别名"); await publish(sourceA.info.name, true);
  assert(byIdentity(await catalog(), sourceIdentity).namePreferences.some((n) => n.name === "源程序专用显示"), "a real SQLITE_FULL publication error retains program name preferences");
  await session.screenshot("02-publication-failure.png"); await publish(sourceA.info.name);
  assert(true, "rendered retry succeeds after the one-shot real storage error"); await session.screenshot("03-publication-retry.png"); await closeSettings();
  await groupsPane(); await exportRendered(sourceGroup, portablePath);
  const entries = zipEntries(portablePath); manifest = JSON.parse(entries.get("manifest.json"));
  assert(manifest.formatVersion === 2 && manifest.images.every((image) => image.snapshot.tags.every((tag) => Boolean(tag.definition?.id) && Boolean(tag.localTagId))), "formal export contains version-two stable definitions and explicit local mappings");
  assert(!JSON.stringify(manifest).includes("源程序专用显示") && manifest.images.some((image) => image.snapshot.tags.some((t) => t.definition.aliases.some((a) => a.name === "白雪新别名"))), "formal export carries latest real aliases and pure defaults, without source display preferences");
  assert(manifest.images.every((image) => sha(entries.get(image.file)) === image.snapshot.sha256), "package original bytes match every declared SHA-256");
  assert(manifest.images.some((image) => image.snapshot.note === "原图构图备注") && manifest.images.some((image) => image.snapshot.tags.some((tag) => tag.definition.namespace === "general" && tag.definition.external.some((entry) => entry.vocabulary === "danbooru" && entry.name === "t11_portable_white"))), "formal package preserves the real note, namespace and external vocabulary/value");
  await session.screenshot("04-exported-package.png");
  await stop();
  copiedA = join(work, "copied-a"); copiedB = join(work, "copied-b"); cpSync(sourceA.info.root, copiedA, { recursive: true }); cpSync(sourceB.info.root, copiedB, { recursive: true });
  renameSync(join(work, "libraries"), join(work, "source-libraries-disconnected")); renameSync(join(work, "source-app"), join(work, "source-app-disconnected"));
  assert(!existsSync(sourceA.info.root) && !existsSync(join(work, "source-app")), "fresh application has no access to the original library or original application directory");
  await launch("copied-libraries", "copied-app");
  await session.invoke("register_library", { root: copiedA }); await session.invoke("register_library", { root: copiedB }); await session.refresh(sourceB.info.id); view = await catalog();
  assert(mapping(view, sourceA.info.id, sourceA.local).catalogId === sourceIdentity && mapping(view, sourceB.info.id, sourceB.local).catalogId === splitIdentity, "ordinary copied libraries restore the published correction/split identities in an empty application");
  assert(byIdentity(view, sourceIdentity).namePreferences.length === 0 && byIdentity(view, sourceIdentity).defaultNames.some((n) => n.name === "白") && byIdentity(view, sourceIdentity).aliases.some((a) => a.name === "白雪新别名"), "ordinary copied library restores current defaults and aliases without program preferences");
  await inspectControls(); await session.screenshot("05-copied-library-identities.png");
  await launch("fresh-package", "fresh-app");
  const targetParent = join(work, "targets"); mkdirSync(targetParent); freshTarget = await session.invoke("create_library", { parent: targetParent, name: "空应用包目标" }); await session.refresh(freshTarget.id);
  await groupsPane(); const imported = await importRendered(portablePath); view = await catalog();
  assert(imported.members.length === 3 && imported.members.every((m) => m.libraryId === freshTarget.id), "rendered package import creates a new group with all members remapped to the chosen library");
  assert(imported.members.every((m, i) => JSON.stringify(m.crop) === JSON.stringify(sourceGroup.members[i].crop) && JSON.stringify(m.placement) === JSON.stringify(sourceGroup.members[i].placement)), "native package roundtrip preserves every member crop, flip, rotation, scale and layout");
  assert(imported.importedFromPackage.packageId === manifest.packageId && imported.importedFromPackage.groupId === sourceGroup.id, "native package import retains source group and package provenance");
  assert([sourceIdentity, splitIdentity].every((id) => view.catalog.mappings.some((m) => m.libraryId === freshTarget.id && m.catalogId === id)) && view.catalog.tags.every((t) => t.namePreferences.length === 0), "empty application imports both stable tag identities and no source preferences");
  assert(Object.values(originals(freshTarget.root)).sort().join() === [...new Set(manifest.images.map((image) => image.snapshot.sha256))].sort().join(), "fresh destination stores the exact original image bytes");
  await session.click(`//li[@class='reference-group' and @data-id='${imported.id}']//button[normalize-space()='成员']`); await until("rendered three available members", () => session.exec("return document.querySelectorAll('.reference-group-members li').length === 3 && [...document.querySelectorAll('.reference-group-members li')].every(e => e.textContent.includes('可用'));"));
  await session.click(`//li[@class='reference-group' and @data-id='${imported.id}']//button[normalize-space()='钉到桌面']`);
  await until("imported members produce native pins", () => existsSync(join(dataDir, "pins.json")) && JSON.parse(readFileSync(join(dataDir, "pins.json"), "utf8")).pins.length === 3);
  assert(true, "rendered imported members are available and open as three real native reference pins"); await session.screenshot("06-fresh-package-group.png");
  await launch("existing-package", "existing-app");
  existingTarget = await create("已有偏好目标", [paths[3]]); view = await catalog(); const existingIdentity = mapping(view, existingTarget.info.id, existingTarget.local).catalogId;
  const existingGroupId = await session.invoke("create_shared_tag_group", { name: "目标程序分组", namespace: null });
  await session.invoke("edit_shared_tag_group", { safeMode: true, edit: { kind: "addMembers", groupId: existingGroupId, tagIds: [existingIdentity] } });
  await prefer(existingIdentity, "我的原有白色"); await closeSettings();
  const existingGroups = await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true });
  await groupsPane(); await importRendered(portablePath); view = await catalog();
  assert(JSON.stringify(await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true })) === JSON.stringify(existingGroups), "content import preserves the destination application's existing global group definition and order");
  assert([sourceIdentity, splitIdentity, existingIdentity].every((id) => byIdentity(view, id)) && byIdentity(view, existingIdentity).names.some((n) => n.name === "我的原有白色"), "same-named target tag remains independent and its existing preference survives import");
  await prefer(sourceIdentity, "目标应用偏好"); await names(sourceIdentity); await session.click(`${nameRow(sourceIdentity)}//button[@aria-label='去掉别名“雪”']`); await until("target alias removed", async () => !byIdentity(await catalog(), sourceIdentity).aliases.some((a) => a.name === "雪")); await closeSettings();
  await groupsPane(); await importRendered(portablePath); view = await catalog();
  assert(byIdentity(view, sourceIdentity).names.some((n) => n.name === "目标应用偏好") && !byIdentity(view, sourceIdentity).aliases.some((a) => a.name === "雪"), "reimport preserves the current application preference and does not resurrect a deleted alias");
  assert(view.catalog.mappings.filter((m) => m.libraryId === existingTarget.info.id).length === 3, "reimport reuses each declared stable identity without adding duplicate local tags");
  assert(JSON.stringify(await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true })) === JSON.stringify(existingGroups), "content reimport also keeps the current global group unchanged");
  await inspectControls(); await session.screenshot("07-existing-preferences.png");
  await stop();
  const reimportedCopy = join(work, "reimported-copy"); cpSync(existingTarget.info.root, reimportedCopy, { recursive: true });
  await launch("reimported-copy", "reimported-copy-app");
  await session.invoke("register_library", { root: reimportedCopy }); await session.refresh(existingTarget.info.id); view = await catalog();
  assert(!byIdentity(view, sourceIdentity).aliases.some((a) => a.name === "雪") && view.catalog.tags.every((tag) => tag.namePreferences.length === 0), "a copied destination library carries its current pure definitions immediately after reimport, without any application preference");
  await inspectControls(); await session.screenshot("08-reimported-copy.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", application, build, harnessSource, harnessSha256, assertions, environments, sourceA, sourceB, sourceIdentity, splitIdentity, sourceGroup, freshTarget, existingTarget, packageSha256: sha(readFileSync(portablePath)), filePicker: "queued existing testPick results; actual rendered actions and native backend", cleanup: "WebDriver session deletion plus own exact executable process cleanup; not a normal tray-quit acceptance" }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) {
    await session.screenshot(`failure-${phase}.png`).catch(() => {});
    await session.exec("return document.documentElement.outerHTML;").then((html) => writeFileSync(join(work, `failure-${phase}.html`), html)).catch(() => {});
  }
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", phase, error: String(error), application, build, harnessSource, harnessSha256, assertions, environments, sourceA, sourceB, sourceIdentity, splitIdentity, sourceGroup }, null, 2)); process.exitCode = 1;
} finally { await stop(); }
