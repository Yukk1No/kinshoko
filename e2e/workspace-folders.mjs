// #78 T08: formal native directory forest and scope acceptance.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/workspace-folders.mjs <owned kinshoko.exe> <matching msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `workspace-folders-${Date.now()}`);
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
const port = 4558;
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
  async click(xpath) {
    return until("click " + xpath, async () => {
      const id = await this.find(xpath);
      await wd("POST", `${this.base}/element/${id}/click`, {});
      return true;
    });
  }
  async type(xpath, value) { const id = await this.find(xpath); return wd("POST", `${this.base}/element/${id}/value`, { text: value, value: [...value] }); }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore", windowsHide: true });
}

function png(path, seed) {
  const header = Buffer.alloc(13); header.writeUInt32BE(120, 0); header.writeUInt32BE(90, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(361); row[0] = 0;
  for (let x = 0; x < 120; x++) { row[x * 3 + 1] = seed; row[x * 3 + 2] = 28; row[x * 3 + 3] = 38; }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 90 }, () => row)))), chunk("IEND", Buffer.alloc(0))]));
}

const harnessSource = spawnSync("git", ["--work-tree=" + process.cwd(), "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const harnessSha256 = createHash("sha256").update(readFileSync(resolve(process.argv[1]))).digest("hex");
const build = JSON.parse(readFileSync(resolve("work/e2e/t08-build-source.json"), "utf8").replace(/^\uFEFF/, ""));
const source = build.source;
const tree = build.tree;
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
if (binarySha256.toLowerCase() !== build.binarySha256.toLowerCase()) throw new Error("native binary does not match the recorded product build");
let environment;
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4559", "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const blank = { conditions: [] };
const scopeAll = { kind: "all" };
const scoped = (libraryId, scope) => ({ kind: "library", libraryId, scope });
const browse = (scope = scopeAll, safeMode = true, cursor = null, limit = 100) => session.invoke("workspace_browse", { query: { scope, conditions: blank, cursor, limit, thumbnailPx: 128 }, safeMode });
const uiTotal = (number) => until(`wall total ${number}`, () => session.exec("return document.querySelector('.wall')?.dataset.total === arguments[0];", [String(number)]));
const folderButton = (library, folder) => `//*[@data-library-id='${library}']//button[@data-folder-id='${folder}']`;
const libraryButton = (library) => `//*[@data-library-id='${library}']/*[@class='workspace-provider-root']/button[@class='sidebar-item']`;
const rootElement = (library) => `document.querySelector('[data-library-id="${library}"]')`;
function originalFiles(root) {
  const result = {};
  function walk(at) {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".png")) result[path.slice(root.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  walk(join(root, "originals")); return result;
}
const restart = async () => {
  if (session) await session.close(); session = null; quitOwnApp(); await delay(600);
  session = await Session.start();
};
let first, second, originalBefore, originalAfter;
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((response) => response.ok));
  session = await Session.start();
  environment = await session.exec("return { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent }; ");
  const paths = ["direct", "nested", "unassigned", "second"].map((name, i) => { const path = join(work, name + ".png"); png(path, 18 + i * 19); return path; });
  const create = async (parentName, selected) => {
    const parent = join(libraries, parentName); mkdirSync(parent);
    const info = await session.invoke("create_library", { parent, name: "目录参考" });
    await session.invoke("start_import", { libraryId: info.id, source: { paths: selected } });
    const page = await until("import " + parentName, async () => {
      const page = await browse(scoped(info.id, scopeAll)); return page.total === selected.length ? page : null;
    });
    const images = {};
    for (const card of page.cards) {
      const detail = await session.invoke("workspace_image", { libraryId: info.id, imageId: card.imageId });
      images[detail.originalName] = card.imageId;
    }
    const root = await session.invoke("create_folder", { libraryId: info.id, name: "人物", parent: null });
    const child = await session.invoke("create_folder", { libraryId: info.id, name: "动作", parent: root });
    const other = await session.invoke("create_folder", { libraryId: info.id, name: "精选", parent: null });
    return { info, images, root, child, other };
  };
  first = await create("a", paths.slice(0, 3));
  await session.invoke("edit", { libraryId: first.info.id, ids: [first.images["direct.png"]], edits: [{ kind: "addToFolder", folderId: first.root }] });
  await session.invoke("edit", { libraryId: first.info.id, ids: [first.images["nested.png"]], edits: [{ kind: "addToFolder", folderId: first.child }, { kind: "addToFolder", folderId: first.other }] });
  second = await create("b", [paths[1], paths[3]]);
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.images["second.png"]], edits: [{ kind: "addToFolder", folderId: second.root }] });
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.images["nested.png"]], edits: [{ kind: "addToFolder", folderId: second.child }] });
  originalBefore = { a: originalFiles(first.info.root), b: originalFiles(second.info.root) };
  await restart();
  await uiTotal(4);
  await until("both complete directory roots", () => session.exec("return [...document.querySelectorAll('.workspace-provider')].filter(el => el.querySelectorAll('[data-folder-id]').length === 3).length === 2;"));
  let forest = await session.invoke("workspace_directories", { safeMode: true });
  assert(forest.providers.length === 2 && forest.providers.every(p => p.sidebar.folders.some(f => f.name === "人物" && f.children[0]?.name === "动作")), "same-named libraries retain independent complete directory trees");
  assert(await session.exec(`return ${rootElement(first.info.id)}.textContent.includes(arguments[0]) && ${rootElement(second.info.id)}.textContent.includes(arguments[1]);`, [first.info.root, second.info.root]), "formal roots show distinct paths for same-named libraries");
  await session.screenshot("directory-forest.png");
  await session.click(folderButton(first.info.id, first.root));
  await uiTotal(2);
  assert(await session.exec("return document.querySelector('.workspace-descendants input')?.checked === true;"), "folder selection defaults to including descendants");
  assert((await session.invoke("current_library")).id === second.info.id, "directory browsing does not activate another library or change write target");
  await session.click("//label[contains(.,'包含子文件夹')]/input");
  await uiTotal(1);
  const direct = await browse(scoped(first.info.id, { kind: "folder", id: first.root }));
  assert(direct.total === 1 && direct.cards[0].imageId === first.images["direct.png"], "unchecked descendants queries only direct membership");
  await session.click("//label[contains(.,'包含子文件夹')]/input");
  await uiTotal(2);
  const nested = (await browse(scoped(first.info.id, { kind: "folderTree", id: first.root }))).cards.find(c => c.imageId === first.images["nested.png"]);
  assert(nested.sources.length === 2 && nested.sources.filter(s => s.matches).length === 1, "folder matching is complete per source before byte deduplication");
  assert((await session.invoke("workspace_image", { libraryId: first.info.id, imageId: first.images["nested.png"] })).folders.length === 2, "multiple folder memberships remain visible through formal source detail");
  await session.screenshot("descendant-scope.png");
  await session.click(`//*[@data-library-id='${first.info.id}']//button[.//span[text()='未归类']]`);
  await uiTotal(1);
  assert((await browse(scoped(first.info.id, { kind: "unassigned" }))).cards[0].imageId === first.images["unassigned.png"], "unassigned range belongs only to the chosen provider");
  await session.click(libraryButton(second.info.id)); await uiTotal(2);
  await session.click(`//*[@data-library-id='${second.info.id}']//button[@aria-label='新建文件夹']`);
  await session.type("//input[@aria-label='新文件夹名称']", "原生新建");
  await until("created folder rendered", () => session.exec(`return ${rootElement(second.info.id)}.textContent.includes('原生新建');`));
  assert((await session.invoke("workspace_directories", { safeMode: true })).providers.find(p => p.registration.library.id === second.info.id).sidebar.folders.some(f => f.name === "原生新建"), "existing create-folder action updates its explicit provider root");
  await session.exec("const button = document.querySelector('[data-folder-id=\"' + arguments[0] + '\"]'); button.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));", [second.child]);
  const renameId = await session.find("//input[@aria-label='文件夹名称']");
  await wd("POST", `${session.base}/element/${renameId}/clear`, {});
  await session.type("//input[@aria-label='文件夹名称']", "动作改名");
  await until("renamed folder rendered", () => session.exec(`return ${rootElement(second.info.id)}.textContent.includes('动作改名');`));
  assert(!(await session.invoke("workspace_directories", { safeMode: true })).providers.find(p => p.registration.library.id === first.info.id).sidebar.folders.some(f => f.children.some(c => c.name === "动作改名")), "rename changes only the chosen library's folder tree");
  let request = scoped(second.info.id, { kind: "folderTree", id: second.root });
  const beforeMove = await browse(request, true, null, 1);
  await session.invoke("move_folder", { libraryId: second.info.id, folderId: second.child, parent: second.other, position: 0 });
  assert(await browse(request, true, beforeMove.nextCursor, 1).then(() => false, () => true), "moving a subtree rejects the old scope pagination cursor");
  await session.click(folderButton(second.info.id, second.root)); await uiTotal(1);
  await session.click(folderButton(second.info.id, second.other)); await uiTotal(1);
  assert((await browse(scoped(second.info.id, { kind: "folderTree", id: second.other }))).cards[0].imageId === second.images["nested.png"], "moved subtree membership follows its actual new parent");
  originalAfter = { a: originalFiles(first.info.root), b: originalFiles(second.info.root) };
  assert(JSON.stringify(originalAfter) === JSON.stringify(originalBefore), "folder organizing leaves original image file paths and bytes unchanged");
  await session.invoke("edit", { libraryId: second.info.id, ids: [second.images["nested.png"]], edits: [{ kind: "setRating", rating: "explicit" }] });
  await session.click(folderButton(first.info.id, first.root)); await uiTotal(1);
  assert((await browse(scoped(first.info.id, { kind: "folderTree", id: first.root }))).total === 1, "out-of-scope Adult source still vetoes the shared card in a descendant scope");
  forest = await session.invoke("workspace_directories", { safeMode: true });
  assert(forest.providers.find(p => p.registration.library.id === first.info.id).sidebar.folders.find(f => f.id === first.root).children[0].count === 0, "directory counts use the same all-source safety veto");
  await session.screenshot("folder-safety-veto.png");
  await session.click(folderButton(second.info.id, second.other)); await uiTotal(0);
  await session.click("//summary[text()='资料库操作']");
  await session.click(`//li[span[contains(.,'${second.info.root}')]]/button[contains(@aria-label,'取消登记')]`);
  await until("removed selected provider remains invalid scope", () => session.exec("return document.querySelector('.workspace-current-scope')?.textContent.includes('资料库已失效');"));
  assert(await session.exec("return document.querySelector('[aria-label=\"查找范围\"] > button')?.getAttribute('aria-current') !== 'page';"), "removed selected provider does not silently replace range with all libraries");
  assert(await browse(request).then(() => false, () => true), "removed provider query returns an explicit failure");
  await session.screenshot("removed-scope.png");
  await session.click("//nav[@aria-label='查找范围']/button[text()='全部资料库']"); await uiTotal(3);
  await session.close(); session = null; quitOwnApp(); await delay(600);
  renameSync(first.info.root, first.info.root + ".offline");
  session = await Session.start();
  await until("disconnected root visible", () => session.exec("return document.querySelector('.workspace-provider')?.textContent.includes('暂时不可用');"));
  assert(await session.exec("return document.querySelector('.workspace-provider-root .sidebar-item')?.disabled && !document.querySelector('[data-folder-id]');"), "disconnected provider keeps an explicit disabled root and discards cached folder controls");
  await session.screenshot("disconnected-root.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", source, tree, binarySha256, application, harnessSource, harnessSha256, environment, first, second, originalBefore, originalAfter, assertions, stories: [6, 7, 8] }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", source, tree, binarySha256, application, harnessSource, harnessSha256, environment, first, second, assertions, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
