// 按钮质感（方案 A）的日间、夜间截图：欢迎页、主按钮悬停、空图库、设置几页、多选、清空回收站的确认对话框。
// 夜间用 :root[data-theme="dark"] 强制，与系统深色走同一套令牌。
// Usage: node e2e/button-material.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/button-material.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4582;
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
  async find(xpath, timeout) {
    return until("find " + xpath, async () => (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT], timeout);
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
  /** 指针移到窗口左下角的空处。 */
  park() { return wd("POST", `${this.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 200, y: 880 }] }] }); }
  /** 指针停在元素中心，用来截悬停。 */
  async hover(css) {
    const id = (await wd("POST", `${this.base}/element`, { using: "css selector", value: css }))[ELEMENT];
    return wd("POST", `${this.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: { [ELEMENT]: id }, x: 0, y: 0 }] }] });
  }
  close() { return wd("DELETE", this.base); }
  async theme(name) { await this.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]); await delay(500); }
  async capture(name, path) {
    for (const theme of ["light", "dark"]) {
      await this.theme(theme);
      writeFileSync(join(work, `${name}-${theme === "light" ? "day" : "night"}.png`), Buffer.from(await wd("GET", path()), "base64"));
    }
    await this.theme("light");
    console.log("shot", name);
  }
  /** 同一画面截日间、夜间两张，截完回到日间。 */
  shot(name) { return this.capture(name, () => `${this.base}/screenshot`); }
  /** 只截一个元素（日间、夜间）。 */
  async shotElement(css, name) {
    const id = (await wd("POST", `${this.base}/element`, { using: "css selector", value: css }))[ELEMENT];
    return this.capture(name, () => `${this.base}/element/${id}/screenshot`);
  }
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
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]], [[38, 70, 83], [244, 162, 97]], [[58, 134, 255], [255, 190, 11]]];
const sizes = [[240, 320], [320, 240], [240, 240], [200, 340], [320, 200], [260, 300], [300, 220], [220, 300]];
const settle = () => delay(900);
const escape = () => session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
const closeToasts = () => until("notices closed", async () => {
  await session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;"); await delay(400);
  return session.exec("return !document.querySelector('.k-toast-close');");
});
const card = (i) => session.exec("return [...document.querySelectorAll('.wall [data-id]')][arguments[0]].dataset.id;", [i]);
const pick = (id, ctrl) => session.exec("document.querySelector(`[data-id=\"${arguments[0]}\"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: arguments[1] })); return true;", [id, ctrl]);
const rightClick = (selector) => session.exec(`const el = document.querySelector(arguments[0]); const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true;`, [selector]);
const failures = [];
/** 一步失败只记下来，后面的照常截。 */
async function step(label, run) {
  try { await run(); } catch (error) { failures.push(`${label}: ${error.message}`); console.log("FAILED", label, error.message); try { await escape(); await escape(); } catch {} }
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));")); await settle();

  // 欢迎页：主按钮和普通按钮，再截主按钮悬停。
  await step("welcome", () => session.shot("01-welcome"));
  await step("welcome hover", async () => { await session.hover(".welcome-card .k-btn.is-primary"); await settle(); await session.shotElement(".welcome-card", "02-welcome-primary-hover"); await session.park(); });

  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("empty wall", () => session.exec("return Boolean(document.querySelector('.wall-empty'));"));
  await settle(); await closeToasts(); await settle();
  await step("empty library", () => session.shot("03-empty-library"));

  await step("import", async () => {
    await session.invoke("start_import", { libraryId: info.id, source: { paths } });
    await until("wall", () => session.exec(`return document.querySelector('.wall')?.dataset.total === '${paths.length}';`), 30000); await settle();
  });
  await closeToasts().catch(() => {});

  // 设置里带按钮的几页。
  await step("settings", async () => {
    await session.click("//nav[@class='rail']//button[@aria-label='设置']");
    await until("settings", () => session.exec("return Boolean(document.querySelector('.k-settings:not(.is-loading)'));")); await settle();
    await session.park(); await session.shot("04-settings-general");
    for (const [name, file] of [["标签", "05-settings-tags"], ["自动标签", "06-settings-tagging"], ["备份", "07-settings-backup"], ["更新", "08-settings-update"]]) {
      await step(file, async () => { await session.click(`//*[@role='tab' and contains(., '${name}')]`); await session.park(); await settle(); await session.shot(file); });
    }
    await escape(); await settle();
  });

  // 危险按钮：两张图移到回收站，再清空回收站的确认对话框。
  await step("empty trash dialog", async () => {
    await pick(await card(0), true); await pick(await card(1), true);
    await until("selection bar", () => session.exec("return Boolean(document.querySelector('[role=toolbar][aria-label=已选参考图操作]'));"), 8000); await settle();
    await session.shot("09-multi-select");
    await session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); return true;");
    await settle(); await closeToasts().catch(() => {});
    await session.click("//*[contains(., '回收站') and (self::button or @role='treeitem' or self::a)]"); await settle();
    await session.click("//button[contains(., '清空')]");
    await until("confirm", () => session.exec("return Boolean(document.querySelector('.permanent-delete .k-btn.is-danger:not(:disabled)'));"), 10000); await settle();
    await session.shot("10-empty-trash-confirm");
    await escape(); await settle();
  });
  console.log(`Evidence: ${work}`);
} finally {
  if (failures.length) { console.log("Failed steps:"); for (const f of failures) console.log(" - " + f); }
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
