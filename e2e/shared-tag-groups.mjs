// #78 T05: shared group management, legacy provenance, OR search, safety and restart.
// Fixture creation uses the released v16 schema. All group actions/readback use public IPC or rendered controls.
// Usage: node e2e/shared-tag-groups.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { chunk, driverClient, ihdr, oldLibrary } from "./shared-tag-groups.helpers.mjs";
import { createDriver } from "./lib/driver.mjs";

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
const row = Buffer.from([0, 18, 28, 38, 18, 28, 38, 18, 28, 38]);
writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]));
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4464);
const driverUrl = `http://127.0.0.1:${port}`;
const assertions = [];
function assert(ok, label) { if (!ok) throw new Error(label); assertions.push(label); console.log(`PASS ${label}`); }
const { until, wd, delay, Session } = driverClient({ driverUrl, application, work });
const { quitOwnApp } = createDriver({ driverUrl, application });
const driver = spawn(process.argv[4] ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let session;
const setting = "//button[@aria-label='设置' or normalize-space()='设置']";

const oldSchema = readFileSync("crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql", "utf8");
const oldSchemaSha256 = createHash("sha256").update(oldSchema).digest("hex");
const first = oldLibrary({ libraries, oldSchema }, "角色参考", "blue", 10, true);
const second = oldLibrary({ libraries, oldSchema }, "画法参考", "purple", 20, false);
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
  await clickGroupControl(name, `重命名标签分组“${name}”`);
  await session.set("//input[@aria-label='标签分组名称']", next); await session.key("\uE007");
  await until("renamed group", async () => (await readGroups(await session.invoke("safe_mode"))).some((g) => g.name === next));
}
async function addMember(name, text, expected) {
  await clickGroupControl(name, `给“${name}”添加标签`);
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
  const firstBefore = await session.invoke("image", { libraryId: first.info.id, imageId: first.primaryId });
  await openSettings();
  await until("legacy provenance visible in settings", () => session.exec("return [...document.querySelectorAll('section[aria-label=全局标签分组] .tag-group-origin')].some((node) => node.textContent.includes('角色参考')) && [...document.querySelectorAll('section[aria-label=全局标签分组] .tag-group-origin')].some((node) => node.textContent.includes('画法参考'))"));
  await session.screenshot("legacy-shared-group-provenance.png");
  const firstRow = `${groupPath("发色")}[.//p[contains(.,'角色参考')]]`;
  await session.click(`${firstRow}//button[@aria-label='重命名标签分组“发色”']`);
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
  // #479: deleting a group does not ask first.
  await until("old second group deleted", async () => !(await readGroups()).some((g) => g.id === secondGroup.id));
  await closeSettings();
  const blueId = firstGroup.tags[0].tag.id;
  await session.invoke("edit_tag_name", { catalogId: blueId, edit: { kind: "prefer", name: { lang: "zh-CN", name: "天青发" } } });
  await until("current shared label", async () => (await readGroups()).find((g) => g.name === "安全整理后").tags.some((t) => t.tag.name === "天青发"));
  const firstAfter = await session.invoke("image", { libraryId: first.info.id, imageId: first.primaryId });
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
