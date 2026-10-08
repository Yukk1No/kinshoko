// #78 T05: shared group management, legacy provenance, OR search, safety and restart.
// Fixture creation uses the released v16 schema. All group actions/readback use public IPC or rendered controls.
// Usage: node e2e/shared-tag-groups.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/shared-tag-groups.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const sourceManifest = JSON.parse(readFileSync("work/t05/native-source.json", "utf8"));
const source = sourceManifest.commit;
const harnessSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
if (binarySha256.toLowerCase() !== sourceManifest.binarySha256.toLowerCase()) throw new Error("Native binary does not match its source manifest");
const work = resolve("work", "e2e", `shared-groups-${Date.now()}`);
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
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4464);
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
  async click(xpath) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
      catch (error) {
        if (attempt >= 4 || !/stale element reference|no such element/.test(error.message)) throw error;
        await delay(150);
      }
    }
  }
  async set(xpath, value) {
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!element) throw Error('control missing'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, arguments[1]); element.dispatchEvent(new Event('input', { bubbles: true }));", [xpath, value]);
  }
  async select(xpath, value) {
    await until("enabled select option", () => this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return element && !element.disabled && [...element.options].some((option) => option.value === arguments[1]);", [xpath, value]));
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; element.value = arguments[1]; element.dispatchEvent(new Event('change', { bubbles: true }));", [xpath, value]);
  }
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
const driver = spawn(process.argv[4] ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let session;
const setting = "//button[@aria-label='设置' or normalize-space()='设置']";

const oldSchema = readFileSync("crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql", "utf8");
const oldSchemaSha256 = createHash("sha256").update(oldSchema).digest("hex");
function png(red) {
  const row = Buffer.from([0, red, 28, 38, red, 28, 38, red, 28, 38]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]);
}
function oldLibrary(name, primary, red, isAdult) {
  const root = join(libraries, name); mkdirSync(root);
  const db = new DatabaseSync(join(root, "library.sqlite")); db.exec(oldSchema);
  const identity = (value) => createHash("sha256").update(name + value).digest("hex").slice(0, 32);
  const id = identity("library"); db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id, name);
  const tags = {};
  function addTag(key, label, namespace = "general", external = key) {
    const local = identity(key + namespace); tags[key + namespace] = local;
    db.prepare("INSERT INTO tag VALUES (?,?,1000)").run(local, namespace);
    db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(local, label);
    if (external) db.prepare("INSERT INTO tag_external VALUES (?,?)").run(external, local);
    return local;
  }
  const blue = addTag("blue_hair", "蓝发"), purple = addTag("purple_hair", "紫发"), secret = addTag("spec78_secret", "封印专用词");
  const workTag = addTag("星海", "星海", "work", null), artistTag = addTag("星海", "星海", "artist", null);
  const originals = [];
  function addImage(key, color, ids, adult = false) {
    const bytes = png(color), sha = createHash("sha256").update(bytes).digest("hex");
    const rel = `originals/${sha.slice(0, 2)}/${sha}.png`;
    mkdirSync(join(root, "originals", sha.slice(0, 2)), { recursive: true }); writeFileSync(join(root, rel), bytes);
    const imageId = identity(key);
    db.prepare("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at,rating_manual) VALUES (?,?,?,'png',?,3,3,1,?,1000,?)").run(imageId, sha, bytes.length, rel, key + ".png", adult ? "explicit" : null);
    for (const tag of ids) {
      db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId, tag);
      db.prepare("INSERT INTO tag_decision VALUES (?,?,'add',1000)").run(imageId, tag);
    }
    originals.push({ imageId, path: join(root, rel), sha }); return imageId;
  }
  const primaryId = addImage("primary", red, [primary === "blue" ? blue : purple, workTag, artistTag]);
  const secretId = addImage("secret", 99, [secret], isAdult);
  // The blue file has different local IDs in the two providers but one byte identity.
  if (primary !== "blue") addImage("shared-blue", 10, [blue]);
  const groupId = identity("group-hair");
  db.prepare("INSERT INTO tag_group VALUES (?, '发色', NULL,0,1000)").run(groupId);
  db.prepare("INSERT INTO tag_group_member VALUES (?,?,0)").run(groupId, primary === "blue" ? blue : purple);
  if (primary === "blue") db.prepare("INSERT INTO tag_group VALUES (?, '作品','work',1,1000)").run(identity("group-work"));
  db.close(); return { info: { id, root, name }, groupId, primaryId, secretId, tags, originals };
}
const first = oldLibrary("角色参考", "blue", 10, true);
const second = oldLibrary("画法参考", "purple", 20, false);
let sharedGroup;
async function readGroups(safe = true) { return session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: safe }); }
async function openSettings() {
  if (!await session.exec("return Boolean(document.querySelector('[role=dialog][aria-label=程序设置]'))")) await session.click(setting);
  await until("global group settings", () => session.find("//section[@aria-label='全局标签分组']"));
  await session.exec("document.querySelector('section[aria-label=全局标签分组]').scrollIntoView({block:'start'})");
}
async function closeSettings() { await session.click("//button[normalize-space()='关闭设置']"); }
const groupPath = (name) => `//section[@aria-label='全局标签分组']//div[@role='group' and @aria-label='${name}']`;
async function clickGroupControl(name, label) {
  const xpath = `${groupPath(name)}//button[@aria-label='${label}']`;
  await until("enabled group control", () => session.exec("const button = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return button && !button.disabled;", [xpath]));
  await session.click(xpath);
}
async function renameGroup(name, next) {
  await clickGroupControl(name, `改名标签分组“${name}”`);
  await session.set("//input[@aria-label='标签分组名称']", next); await session.key("\uE007");
  await until("renamed group", async () => (await readGroups(await session.invoke("safe_mode"))).some((g) => g.name === next));
}
async function addMember(name, text, expected) {
  await clickGroupControl(name, `给“${name}”加标签`);
  await session.set("//input[@aria-label='挑一个统一标签']", text);
  await until("global candidate", () => session.find(`${groupPath(name)}//li[@role='option' and contains(.,'${expected}')]`));
  await session.click(`${groupPath(name)}//li[@role='option' and contains(.,'${expected}')]`);
  await until("saved member", async () => (await readGroups(await session.invoke("safe_mode"))).find((g) => g.name === name)?.tags.some((t) => t.tag.name === expected));
  await until("updated member controls", () => session.find(`${groupPath(name)}//button[contains(@aria-label,'${expected}（')]`));
}
async function createGroup(name) {
  await session.click("//section[@aria-label='全局标签分组']//button[@aria-label='新建标签分组']");
  await session.set("//input[@aria-label='新标签分组名称']", name); await session.key("\uE007");
  await until("new global group", async () => (await readGroups(await session.invoke("safe_mode"))).some((g) => g.name === name));
}
async function mode(on) {
  await session.click(`//button[@aria-label='安全模式：${on ? "关闭" : "开启"}']`);
  await until("saved safe mode", async () => await session.invoke("safe_mode") === on);
}
async function uiTotal(total) { await until(`wall total ${total}`, () => session.exec("return Number(document.querySelector('.wall')?.dataset.total) === arguments[0]", [total])); }
async function normalQuit(label) {
  const receipt = join(work, `${label}-normal-quit.json`);
  const quit = spawnSync("python", ["e2e/native-tray-exit-t05.py", application, receipt], { windowsHide: true, encoding: "utf8", timeout: 45000 });
  if (quit.status !== 0 || !JSON.parse(readFileSync(receipt, "utf8")).processEnded) throw new Error(`Normal Quit failed (${label}): ${quit.stderr}`);
  await session.close().catch(() => {}); session = null;
}
async function restart(label) {
  await normalQuit(label); session = await Session.start();
  await until("restored main controls", () => session.find(setting));
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start(); await session.invoke("set_safe_mode", { on: true });
  for (const library of [first, second]) {
    const info = await session.invoke("register_library", { root: library.info.root });
    assert(info.id === library.info.id, `released v16 ${info.name} opens with stable identity`);
  }
  await restart("initial-enrollment"); await uiTotal(2);
  let groups = await readGroups();
  assert(groups.filter((g) => g.name === "发色").length === 2, "same-name legacy groups do not overwrite one another");
  const firstGroup = groups.find((g) => g.sources.some((source) => source.libraryId === first.info.id && source.groupId === first.groupId));
  const secondGroup = groups.find((g) => g.sources.some((source) => source.libraryId === second.info.id && source.groupId === second.groupId));
  assert(firstGroup?.tags.length === 1 && firstGroup.tags[0].tag.name === "蓝发" && secondGroup?.tags[0].tag.name === "紫发", "old group members and distinct provider provenance survive migration");
  assert(!JSON.stringify(groups).includes("封印专用词"), "global group read does not reveal all-source vetoed member names");
  const inspected = await session.invoke("inspect_tag_catalog");
  assert(!JSON.stringify(inspected).includes("封印专用词"), "ordinary name settings apply the same all-source Adult veto");
  const namePlan = await session.invoke("plan_legacy_names");
  assert(!JSON.stringify(namePlan).includes("封印专用词"), "legacy name wizard hides names from globally vetoed copies");
  const firstBefore = await session.invoke("workspace_image", { libraryId: first.info.id, imageId: first.primaryId });
  await openSettings();
  await until("legacy provenance visible in settings", () => session.exec("return [...document.querySelectorAll('section[aria-label=全局标签分组] .tag-group-origin')].some((node) => node.textContent.includes('角色参考')) && [...document.querySelectorAll('section[aria-label=全局标签分组] .tag-group-origin')].some((node) => node.textContent.includes('画法参考'))"));
  await session.screenshot("legacy-shared-group-provenance.png");
  const firstRow = `${groupPath("发色")}[.//p[contains(.,'角色参考')]]`;
  await session.click(`${firstRow}//button[@aria-label='改名标签分组“发色”']`);
  await session.set("//input[@aria-label='标签分组名称']", "两库发色"); await session.key("\uE007");
  await until("first group renamed only", async () => (await readGroups()).some((g) => g.name === "两库发色"));
  await addMember("两库发色", "紫", "紫发");
  await clickGroupControl("两库发色", "上移“紫发”在“两库发色”中的顺序");
  await until("member order persisted", async () => (await readGroups()).find((g) => g.name === "两库发色")?.tags[0].tag.name === "紫发");
  sharedGroup = (await readGroups()).find((g) => g.name === "两库发色");
  const definitionIds = sharedGroup.tags.map((tag) => tag.tag.id);
  assert(definitionIds.includes(firstGroup.tags[0].tag.id) && definitionIds.includes(secondGroup.tags[0].tag.id), "formal editor uses unified member identities across libraries");
  const orderBefore = (await readGroups()).map((g) => g.id);
  if (orderBefore.indexOf(sharedGroup.id) > 0) await clickGroupControl("两库发色", "上移标签分组“两库发色”");
  else await clickGroupControl("两库发色", "下移标签分组“两库发色”");
  await until("group order persisted", async () => (await readGroups()).map((g) => g.id).join() !== orderBefore.join());
  await session.screenshot("formal-group-edit-sort.png");
  await closeSettings();
  await until("refreshed accepted group bar", () => session.find("//div[@role='toolbar' and @aria-label='标签分组']//button[contains(.,'两库发色')]"));
  await session.click("//div[@role='toolbar' and @aria-label='标签分组']//button[contains(.,'两库发色')]");
  await session.click("//button[@aria-label='按“两库发色”任一标签查找']");
  await uiTotal(2);
  assert(await session.exec("return document.querySelectorAll('.search-chip').length === 1 && document.body.textContent.includes('紫发') && document.body.textContent.includes('蓝发')"), "group click expands visible members into one OR search condition");
  await session.screenshot("formal-visible-or-condition.png");
  for (const library of [first, second]) {
    await session.select("//select[@aria-label='当前资料库']", library.info.id);
    await until("active provider switched", async () => (await session.invoke("current_library"))?.id === library.info.id);
    await until("same shared group remains in formal bar", () => session.find("//div[@role='toolbar' and @aria-label='标签分组']//button[contains(.,'两库发色')]"));
    assert((await readGroups()).find((g) => g.id === sharedGroup.id)?.tags.map((t) => t.tag.id).join() === definitionIds.join(), `switching to ${library.info.name} preserves unified group membership and order`);
    await uiTotal(2);
  }
  const resolved = await session.invoke("workspace_resolve", { input: { conditions: [{ any: definitionIds.map((id) => ({ kind: "tag", id, dismissed: [] })), negate: false }], exact: true }, lang: "zh-CN", safeMode: true });
  const scoped = await session.invoke("workspace_browse", { query: { scope: { kind: "library", libraryId: second.info.id, scope: { kind: "all" } }, conditions: resolved, cursor: null, limit: 20, thumbnailPx: 128 }, safeMode: true });
  assert(scoped.total === 2 && scoped.cards.every((card) => card.sources.some((source) => source.libraryId === second.info.id && source.matches)), "OR membership translates to different local IDs in an explicit provider");
  await mode(false); await openSettings();
  await addMember("两库发色", "封印专用", "封印专用词");
  await closeSettings(); await mode(true); await openSettings();
  assert(!await session.exec("return document.querySelector('section[aria-label=全局标签分组]').textContent.includes('封印专用词')"), "safe management view hides duplicate Adult member despite an Unknown copy");
  await renameGroup("两库发色", "安全整理后");
  await clickGroupControl("安全整理后", "把“蓝发”移出“安全整理后”");
  await until("visible member removed", async () => !(await readGroups()).find((g) => g.name === "安全整理后").tags.some((t) => t.tag.name === "蓝发"));
  await addMember("安全整理后", "蓝发", "蓝发");
  await clickGroupControl("安全整理后", "上移“蓝发”在“安全整理后”中的顺序");
  await until("safe member order", async () => (await readGroups()).find((g) => g.name === "安全整理后").tags[0].tag.name === "蓝发");
  await closeSettings(); await mode(false);
  const unsafe = (await readGroups(false)).find((g) => g.name === "安全整理后");
  assert(unsafe.tags.length === 3 && unsafe.tags.some((t) => t.tag.name === "封印专用词"), "safe rename/add/remove/reorder retains hidden member on public unsafe readback");
  await mode(true); await openSettings();
  await clickGroupControl("发色", "删除标签分组“发色”");
  await until("old second group deleted", async () => !(await readGroups()).some((g) => g.id === secondGroup.id));
  await closeSettings();
  const blueId = firstGroup.tags[0].tag.id;
  await session.invoke("edit_tag_name", { catalogId: blueId, edit: { kind: "prefer", name: { lang: "zh-CN", name: "天青发" } } });
  await until("current shared label", async () => (await readGroups()).find((g) => g.name === "安全整理后").tags.some((t) => t.tag.name === "天青发"));
  const firstAfter = await session.invoke("workspace_image", { libraryId: first.info.id, imageId: first.primaryId });
  assert(firstBefore.id === firstAfter.id && firstBefore.originalName === firstAfter.originalName && JSON.stringify(firstBefore.versions) === JSON.stringify(firstAfter.versions), "group management leaves source image identity and version links unchanged");
  await restart("after-global-edits");
  groups = await readGroups();
  assert(!groups.some((g) => g.id === secondGroup.id) && groups.find((g) => g.name === "安全整理后")?.tags.some((t) => t.tag.name === "天青发"), "global edits and deleted legacy migration memory survive a normal full restart");
  assert(groups.find((g) => g.name === "作品").tags.every((t) => t.tag.namespace === "work"), "dynamic namespace group excludes same-name artist identities");
  await session.screenshot("restart-current-shared-names.png");
  await normalQuit("before-offline-active");
  const offlineRoot = second.info.root + ".offline"; renameSync(second.info.root, offlineRoot);
  try {
    session = await Session.start(); await until("workspace without active library", () => session.find(setting));
    let restored = null;
    try { restored = await session.invoke("current_library"); }
    catch (error) {
      assert(String(error).includes("资料库暂时不可用") && String(error).includes(second.info.root), "last-opened IPC reports the disconnected provider explicitly");
    }
    await until("formal no-active provider picker", () => session.exec("const select = document.querySelector('select[aria-label=当前资料库]'); return select && !select.disabled && select.value === '';"));
    assert(restored === null, "missing last-active provider leaves no active library in the formal picker");
    const available = await session.invoke("workspace_status", { safeMode: true });
    assert(available.libraries.some((entry) => entry.library.id === first.info.id && !entry.unavailable), "other provider remains available without activation");
    await openSettings(); await createGroup("无活动库分组"); await renameGroup("无活动库分组", "无活动库仍可整理");
    assert((await readGroups()).some((g) => g.name === "无活动库仍可整理"), "global settings create and rename empty groups without an active provider");
    await session.screenshot("no-active-library-global-settings.png");
    await closeSettings(); await restart("no-active-group-edits");
    assert((await readGroups()).some((g) => g.name === "无活动库仍可整理"), "no-active-library edits persist across restart");
    await normalQuit("finished");
  } finally {
    if (session) { await session.close().catch(() => {}); session = null; quitOwnApp(); }
    renameSync(offlineRoot, second.info.root);
  }
  for (const library of [first,second]) for (const original of library.originals) assert(createHash("sha256").update(readFileSync(original.path)).digest("hex") === original.sha, `${library.info.name} original ${original.imageId} unchanged`);
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", source, harnessSource, binarySha256, application, stories: [28,29], oldSchemaSha256, legacySource: "536cc43c1933e44fc33836f8a439de8cdb0da018 migrations 1-16", assertions, first, second, sharedGroup }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) { await session.screenshot("failure.png").catch(() => {}); await session.exec("return document.body.outerHTML").then((html) => writeFileSync(join(work,"failure.html"),html)).catch(() => {}); }
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", source, harnessSource, binarySha256, application, assertions, error: String(error) }, null, 2)); process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
