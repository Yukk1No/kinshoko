// #356：抽出主窗口文案前后，中文界面的关键页面截图。新数据目录里建库、导入几张合成图、建文件夹，
// 依次截首次启动、图片墙、右键菜单、详情侧栏、查看器、查找、空状态与几个对话框。
// 选择器用中文读屏名称：抽取前后的构建都能走通，也说明读屏名称没有变。
// Usage: node e2e/main-window-copy-356.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/main-window-copy-356.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4572;
const driverUrl = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
/** 合成图：两种颜色沿对角线渐变。 */
function png(path, width, height, [a, b]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(a[c] * (1 - t) + b[c] * t);
    }
    rows.push(row);
  }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]));
}

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
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: JSON.stringify(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async find(xpath) {
    return until("find " + xpath, async () => (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]);
  }
  async click(xpath) {
    const id = await this.find(xpath);
    await wd("POST", `${this.base}/element/${id}/click`, {});
  }
  async type(xpath, text) {
    const id = await this.find(xpath);
    await wd("POST", `${this.base}/element/${id}/value`, { text });
  }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  close() { return wd("DELETE", this.base); }
  async shot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); console.log("shot", name); }
}
function quitOwnApp() {
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore", windowsHide: true });
}

const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const palette = [[[233, 196, 106], [42, 157, 143]], [[244, 162, 97], [38, 70, 83]], [[231, 111, 81], [233, 196, 106]], [[131, 56, 236], [58, 134, 255]],
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]]];
const sizes = [[240, 320], [320, 240], [240, 240], [200, 340], [320, 200], [260, 300]];
const settle = () => delay(900);
const escape = () => session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
const closeToasts = () => until("notices closed", async () => {
  await session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;"); await delay(400);
  return session.exec("return !document.querySelector('.k-toast-close');");
});
const card = (i) => session.exec("return [...document.querySelectorAll('.wall [data-id]')][arguments[0]].dataset.id;", [i]);
const pick = (id, ctrl) => session.exec("document.querySelector(`[data-id=\"${arguments[0]}\"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: arguments[1] })); return true;", [id, ctrl]);
/** 在元素中央右键（Base UI 的右键菜单读 contextmenu 事件的位置）。 */
const rightClick = (selector) => session.exec(`const el = document.querySelector(arguments[0]); const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true;`, [selector]);
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });

  // 首次启动：欢迎页与新建图库。
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  await settle(); await closeToasts();
  await session.shot("01-welcome.png");
  await session.click("//button[@aria-labelledby='welcome-create']"); await settle();
  await session.shot("02-create-library.png");

  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.invoke("start_import", { libraryId: info.id, source: { paths } });
  await until("import", async () => (await session.invoke("workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true })).total === paths.length);
  const people = await session.invoke("create_folder", { libraryId: info.id, name: "人物", parent: null });
  await session.invoke("create_folder", { libraryId: info.id, name: "姿势", parent: people });
  await session.invoke("create_folder", { libraryId: info.id, name: "配色", parent: null });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("wall", () => session.exec(`return document.querySelector('.wall')?.dataset.total === '${paths.length}';`));
  await settle(); await closeToasts();
  // 图片墙与侧栏：展开图库，看到文件夹树。
  await session.click("//button[@aria-label='展开示例参考']"); await settle();
  await session.shot("03-wall.png");

  // 单张的右键菜单，再打开“移到文件夹”子菜单。
  const first = await card(0);
  await rightClick(`[data-id="${first}"]`); await settle();
  await session.shot("04-card-menu.png");
  await session.click("//*[@role='menuitem' and contains(., '移到文件夹')]"); await settle();
  await session.shot("05-card-menu-folders.png");
  await escape(); await escape(); await settle();

  // 空白处的右键菜单。
  await rightClick(".wall"); await settle();
  await session.shot("06-wall-menu.png");
  await escape(); await settle();

  // 详情侧栏：右键时已选中这一张。
  await settle(); await closeToasts();
  await session.shot("07-inspector.png");
  // 多选：操作条。
  await pick(await card(1), true); await pick(await card(2), true); await settle();
  await session.shot("08-multi-select.png");
  await session.exec("document.querySelector('[role=toolbar][aria-label=已选参考图操作] [aria-label=取消选择]').click(); return true;"); await settle();

  // 查看器与它的右键菜单。
  await session.exec("const el = document.querySelector(`[data-id=\"${arguments[0]}\"]`); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;", [first]);
  await until("viewer", () => session.exec("return Boolean(document.querySelector('.viewer'));")); await settle();
  await session.shot("09-viewer.png");
  await rightClick(".viewer-stage"); await settle();
  await session.shot("10-viewer-menu.png");
  await escape(); await settle();
  await session.click("//button[@aria-label='返回图片墙']"); await settle();

  // 查找：打字后的候选。
  await session.type("//input[@aria-label='查找参考图']", "蓝"); await settle();
  await session.shot("11-search.png");
  await escape(); await escape(); await settle();

  // 空文件夹与回收站。
  await session.click("//button[starts-with(@aria-label, '配色（')]"); await settle();
  await session.shot("12-empty-folder.png");
  await session.click("//button[starts-with(@aria-label, '回收站（')]"); await settle();
  await session.shot("13-empty-trash.png");

  // 文件夹的右键菜单与删除确认。
  await rightClick("[aria-label^='人物（']"); await settle();
  await session.shot("14-folder-menu.png");
  await session.click("//*[@role='menuitem' and contains(., '删除文件夹')]"); await settle();
  await session.shot("15-delete-folder.png");
  await session.click("//*[@role='alertdialog']//button[contains(., '取消')]"); await settle();

  // 编辑分组。
  await session.click("//button[contains(@class, 'groupbar-edit')]"); await settle();
  await session.shot("16-tag-groups.png");
  await escape(); await settle();

  // 管理图库。
  await session.click("//button[@aria-label='打开、新建或管理图库']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '管理图库')]"); await settle();
  await session.shot("17-manage-libraries.png");
  await escape(); await settle();
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
