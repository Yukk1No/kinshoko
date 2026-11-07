// #357：抽出桌面与设置文案前后，中文界面的关键页面截图。新数据目录里建库、导入几张合成图，
// 依次截导入结束的提示、导入菜单、从 Eagle 导入、侧栏的参考组与截图历史、设置各页。
// 钉图菜单与截图框选是另外的窗口，不在这里截（由 desktop.en.test.tsx 与各组件测试核对）。
// 写法照 main-window-copy-356.mjs；选择器用中文读屏名称，抽取前后的构建都能走通。
// Usage: node e2e/desktop-settings-copy-357.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/desktop-settings-copy-357.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4574;
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
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });

  // 建库、导入几张合成图，重启后从图库开始。
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.invoke("start_import", { libraryId: info.id, source: { paths: paths.slice(0, 4) } });
  await until("import", async () => (await session.invoke("workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true })).total === 4);
  await session.invoke("create_folder", { libraryId: info.id, name: "人物", parent: null });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("wall", () => session.exec("return document.querySelector('.wall')?.dataset.total === '4';"));
  await settle(); await closeToasts();

  // 导入：再导入两张，截结束的提示；再打开“从 Eagle 导入”（本机没有 Eagle 库时是“手动选择”）。
  await session.invoke("start_import", { libraryId: info.id, source: { paths: paths.slice(4) } });
  await until("import notice", () => session.exec("return Boolean(document.querySelector('.k-toast'));")); await settle();
  await session.shot("01-import-notice.png");
  await closeToasts();
  await session.click("//button[contains(@class, 'k-import')]"); await settle();
  await session.shot("02-import-menu.png");
  await session.click("//*[@role='menuitem' and contains(., '从 Eagle 导入')]");
  await until("eagle dialog", () => session.exec("return Boolean(document.querySelector('.k-import-dialog'));")); await settle();
  await session.shot("03-eagle-libraries.png");
  await escape(); await settle();

  // 侧栏：参考组（空状态与起名）、截图历史。
  await session.click("//nav[@class='rail']//button[@aria-label='参考组']"); await settle();
  await session.shot("04-reference-groups.png");
  await session.click("//button[contains(., '存下桌面钉图')]"); await settle();
  await session.shot("05-reference-group-name.png");
  await escape(); await settle();
  await session.click("//nav[@class='rail']//button[@aria-label='截图历史']"); await settle();
  await session.shot("06-capture-history.png");
  await session.click("//nav[@class='rail']//button[@aria-label='图片与文件夹']"); await settle();

  // 设置各页。
  await session.click("//nav[@class='rail']//button[@aria-label='设置']");
  await until("settings", () => session.exec("return Boolean(document.querySelector('.k-settings:not(.is-loading)'));")); await settle();
  const tab = async (name, file) => { await session.click(`//*[@role='tab' and contains(., '${name}')]`); await settle(); await session.shot(file); };
  await session.shot("07-settings-general.png");
  await tab("快捷键", "08-settings-keys.png");
  await session.exec("document.querySelector('.k-set-main').scrollTop = 10000; return true;"); await settle();
  await session.shot("09-settings-keys-viewer.png");
  await tab("标签", "10-settings-tag-names.png");
  for (const [view, file] of [["对应", "11-settings-tag-mapping.png"], ["相近", "12-settings-tag-approx.png"], ["外观", "13-settings-tag-appearance.png"]]) {
    await session.click(`//*[contains(@class, 'k-set-seg')]//button[contains(., '${view}')]`); await settle();
    if (view === "对应") { await session.click("//button[contains(., '检查标签对应')]"); await settle(); }
    await session.shot(file);
  }
  await tab("自动标签", "14-settings-tagging.png");
  await tab("备份", "15-settings-backup.png");
  await session.exec("document.querySelector('.k-set-main').scrollTop = 10000; return true;"); await settle();
  await session.shot("16-settings-backup-preferences.png");
  await tab("安全", "17-settings-safety.png");
  await tab("更新", "18-settings-update.png");
  await tab("诊断", "19-settings-diagnostics.png");
  await escape(); await settle();
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
