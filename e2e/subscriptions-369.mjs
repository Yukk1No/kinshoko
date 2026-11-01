// #369：订阅画师在真实应用里的关键页面（日间与夜间）：订阅画师对话框、名单行的更多菜单、
// 订阅设置与退订确认、跳过的动图，以及安全模式开着、登录失效时的订阅画师对话框。
// 数据准备同 subscriptions-368.mjs：假账号、不到期的订阅，不访问 pixiv。查找画师与读关注会请求 pixiv，
// 而 Tauri 的 IPC 在页面里改不了，所以不点“查找”“从 pixiv 关注导入”，也不点“订阅”“保存”“退订”。
// Usage: node e2e/subscriptions-369.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/subscriptions-369.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
const data = join(work, "app-data");
const subsDir = join(data, "subscriptions");
mkdirSync(work, { recursive: true });
const port = 4592;
const driverUrl = `http://127.0.0.1:${port}`;

function chunk(type, body) {
  const all = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of all) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, all, checksum]);
}
/** 合成图：两种颜色沿对角线渐变，中间一个浅色圆。 */
function png(path, width, height, [a, b]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const d = Math.hypot(x - width * 0.35, y - height * 0.3) / Math.min(width, height);
      const glow = Math.max(0, 0.45 - d);
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.min(255, Math.round(a[c] * (1 - t) + b[c] * t + glow * 200));
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
    await session.rect({ width: 1440, height: 900 });
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: JSON.stringify(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async click(xpath) {
    const id = await until("find " + xpath, async () => (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))["element-6066-11e4-a52e-4f735466cecf"]);
    await wd("POST", `${this.base}/element/${id}/click`, {});
  }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  close() { return wd("DELETE", this.base); }
  async shot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); console.log("shot", name); }
}
function quitOwnApp() {
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore", windowsHide: true });
}

const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1", KINSHOKO_SUBSCRIPTIONS: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const settle = () => delay(900);
const theme = (name) => session.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]);
const escape = () => session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
const closeToasts = () => session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;");
const toggleSafe = async () => { await session.exec("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true })); return true;"); await delay(1500); };
/** 把鼠标移到主区空白处，图标轨的提示不挡画面。 */
const park = () => wd("POST", `${session.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 900, y: 860 }] }] });
const openSubscriptions = async () => {
  await session.click("//nav//button[@aria-label='订阅']");
  await session.exec("document.activeElement?.blur(); return true;"); await park(); await settle(); await closeToasts();
};
async function restart() {
  await session.close(); quitOwnApp(); await delay(800);
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
}

const palette = [[[233, 196, 106], [42, 157, 143]], [[244, 162, 97], [38, 70, 83]], [[231, 111, 81], [233, 196, 106]], [[131, 56, 236], [58, 134, 255]],
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]], [[239, 71, 111], [255, 209, 102]], [[118, 120, 237], [247, 184, 1]],
  [[140, 179, 105], [244, 226, 133]], [[93, 46, 140], [204, 102, 218]], [[46, 196, 182], [203, 243, 240]], [[255, 159, 28], [255, 191, 105]]];
const sizes = [[240, 330], [320, 230], [250, 250], [220, 360], [320, 210], [260, 300], [240, 280], [300, 240], [230, 340], [280, 260], [250, 320], [310, 220]];

const hover = async (xpath) => {
  const id = await until("find " + xpath, async () => (await wd("POST", `${session.base}/element`, { using: "xpath", value: xpath }))["element-6066-11e4-a52e-4f735466cecf"]);
  await wd("POST", `${session.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: { "element-6066-11e4-a52e-4f735466cecf": id }, x: 0, y: 0 }] }] });
};
/** 两种主题各截一张。 */
const both = async (name) => {
  await theme("light"); await settle(); await session.shot(`${name}-light.png`);
  await theme("dark"); await settle(); await session.shot(`${name}-dark.png`);
  await theme("light"); await settle();
};
const openArtistDialog = async () => {
  await session.click("//aside//button[@aria-label='添加订阅']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '画师')]"); await settle();
};

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("plugin:library|create_library", { parent, name: "pixiv 订阅" });
  await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths } });
  const browse = () => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const page = await until("import", async () => { const p = await browse(); return p.total === paths.length && p; });
  const imageIds = page.cards.map((card) => card.imageId ?? card.id);

  // 先让应用建好订阅记录，再写入示例：登录着的假账号，画师订阅都在 10 分钟前查过，不到期。
  await restart();
  await session.close(); quitOwnApp(); await delay(800);
  mkdirSync(subsDir, { recursive: true });
  writeFileSync(join(subsDir, "pixiv-account.json"), JSON.stringify({ refreshToken: "example-not-a-real-token", account: { userId: "9", name: "yuki_sub", explicitAllowed: true }, expired: false }));
  const now = Date.now();
  const db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  const subs = [["s1", "1001", "Mika"], ["s2", "1002", "ぽち"], ["s3", "1003", "灯里"]];
  const addSub = db.prepare("INSERT INTO subscription (id, source, target, name, library_id, include_explicit, include_manga, created_at, last_checked_at, backlog, since) VALUES (?, 'pixiv', ?, ?, ?, 1, 0, ?, ?, '{\"kind\":\"newOnly\"}', ?)");
  subs.forEach(([id, userId, name], i) => addSub.run(id, JSON.stringify({ kind: "pixivArtist", userId }), name, info.id, now - 86_400_000 + i, now - 10 * 60_000, now - 86_400_000));
  const owners = ["s1", "s1", "s2", "s1", "s3", "s2", "s1", "s2", "s3", "s1", "s1", "s2"];
  const addWork = db.prepare("INSERT INTO received_work (library_id, source, work_id, subscription_id, outcome, explicit, received_at, seen) VALUES (?, 'pixiv', ?, ?, ?, 0, ?, ?)");
  const addPage = db.prepare("INSERT INTO received_page (library_id, source, work_id, page, image_id, received_at) VALUES (?, 'pixiv', ?, 0, ?, ?)");
  imageIds.forEach((imageId, i) => {
    const at = now - i * 3_600_000;
    addWork.run(info.id, `w${i}`, owners[i], "collected", at, i < 4 ? 0 : 1);
    addPage.run(info.id, `w${i}`, imageId, at);
  });
  // Mika 有两个动图跳过了。
  addWork.run(info.id, "u1", "s1", "skippedAnimation", now - 2 * 3_600_000, 1);
  addWork.run(info.id, "u2", "s1", "skippedAnimation", now - 5 * 3_600_000, 1);
  db.close();

  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await openSubscriptions(); await delay(1500);
  // 新装时安全模式开着：先关掉，看 R-18 选项。
  await toggleSafe();

  // A 订阅画师（查找画师要请求 pixiv，这里只截查找前；找到画师与从关注导入由组件测试覆盖）。
  await openArtistDialog();
  await both("A-artist");
  await escape(); await settle();

  // C 名单行的更多菜单、订阅设置与退订确认。
  await hover("//aside//button[contains(@class, 'subs-row') and contains(., 'Mika')]"); await settle();
  await session.click("//aside//button[@aria-label='更多']"); await settle();
  await both("C1-row-menu");
  await session.click("//*[@role='menuitem' and contains(., '订阅设置')]"); await settle();
  await both("C2-settings");
  await session.click("//*[@role='dialog']//button[contains(., '取消')]"); await settle();
  await hover("//aside//button[contains(@class, 'subs-row') and contains(., 'Mika')]"); await settle();
  await session.click("//aside//button[@aria-label='更多']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '退订')]"); await settle();
  await both("C3-remove");
  await session.click("//*[@role='dialog']//button[contains(., '保留')]"); await settle();

  // D 选中 Mika：标题行写出跳过的动图。
  await session.click("//aside//button[contains(@class, 'subs-row') and contains(., 'Mika')]"); await park(); await settle();
  await both("D-skipped");

  // 安全模式开着：对话框里不出现 R-18。
  await toggleSafe();
  await openArtistDialog();
  await both("E-artist-safe-mode");
  await escape(); await settle();

  // 登录失效：能添加，但没有 R-18 与关注导入。
  await session.close(); quitOwnApp(); await delay(800);
  writeFileSync(join(subsDir, "pixiv-account.json"), JSON.stringify({ refreshToken: "example-not-a-real-token", account: { userId: "9", name: "yuki_sub", explicitAllowed: true }, expired: true }));
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await openSubscriptions(); await delay(1500);
  await toggleSafe();
  await openArtistDialog();
  await both("F-artist-expired");
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
