// #368：订阅界面在真实应用里的关键页面（日间与夜间），给维护者和原型对照。
// 新数据目录里建库、导入几张合成图；登录与订阅记录是直接写进数据目录的示例（假账号、不到期的订阅），
// 不访问 pixiv：订阅都在 10 分钟前查过，检查线程不会开始检查。
// Usage: node e2e/subscriptions-368.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/subscriptions-368.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
const data = join(work, "app-data");
const subsDir = join(data, "subscriptions");
mkdirSync(work, { recursive: true });
const port = 4582;
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
const openSubscriptions = async () => { await session.click("//nav//button[@aria-label='订阅']"); await settle(); };
const openSettingsTab = async () => {
  await session.click("//nav//button[@aria-label='设置']"); await settle();
  await session.click("//*[@role='tab' and contains(., '订阅')]"); await settle();
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

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("plugin:library|create_library", { parent, name: "pixiv 订阅" });
  await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths } });
  const browse = () => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: false });
  const page = await until("import", async () => { const p = await browse(); return p.total === paths.length && p; });
  const imageIds = page.cards.map((card) => card.imageId ?? card.id);

  // 没登录：第一次打开订阅页弹出首次使用说明。
  await restart();
  await openSubscriptions();
  await session.shot("05-first-run-light.png");
  await theme("dark"); await settle();
  await session.shot("05-first-run-dark.png");
  await session.click("//*[@role='dialog']//button[contains(., '以后再说')]"); await settle();
  await session.shot("06-signed-out-dark.png");
  await theme("light"); await settle();
  await session.shot("06-signed-out-light.png");
  await openSettingsTab();
  await session.shot("15-settings-signed-out-light.png");
  await theme("dark"); await settle();
  await session.shot("15-settings-signed-out-dark.png");
  await escape(); await theme("light");

  // 已登录、还没有订阅（假账号，没有订阅就不联网）。
  writeFileSync(join(subsDir, "pixiv-account.json"), JSON.stringify({ refreshToken: "example-not-a-real-token", account: { name: "yuki_sub", explicitAllowed: true }, expired: false }));
  await restart();
  await openSubscriptions();
  await session.shot("08-no-subscriptions-light.png");
  await session.click("//main//button[contains(., '添加订阅')]"); await settle();
  await session.shot("04-add-menu-light.png");
  await escape(); await theme("dark"); await settle();
  await session.shot("08-no-subscriptions-dark.png");
  await theme("light");

  // 订阅名单与收进来的图：订阅都在 10 分钟前查过，不到期。
  await session.close(); quitOwnApp(); await delay(800);
  const now = Date.now();
  const db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  const subs = [
    ["s1", { kind: "pixivArtist", userId: "1001" }, "Mika", null],
    ["s2", { kind: "pixivArtist", userId: "1002" }, "ぽち", null],
    ["s3", { kind: "pixivArtist", userId: "1003" }, "灯里", { code: "network" }],
    ["s4", { kind: "pixivRanking", period: "day", top: 50 }, "日榜 前 50", null],
    ["s5", { kind: "pixivBookmarks" }, "我的收藏", null],
  ];
  const addSub = db.prepare("INSERT INTO subscription (id, source, target, name, library_id, include_explicit, include_manga, created_at, last_checked_at, last_error, last_failed_at) VALUES (?, 'pixiv', ?, ?, ?, 1, 0, ?, ?, ?, ?)");
  subs.forEach(([id, target, name, error], i) => addSub.run(id, JSON.stringify(target), name, info.id, now - 86_400_000 + i, now - 10 * 60_000, error && JSON.stringify(error), error ? now - 5 * 60_000 : null));
  // 每张图一件作品：前 5 张是这次新收到的；第 3、9 张是成人作品（安全模式开着时不显示）。
  const owners = ["s1", "s1", "s4", "s1", "s4", "s5", "s1", "s2", "s4", "s5", "s1", "s2"];
  const addWork = db.prepare("INSERT INTO received_work (library_id, source, work_id, subscription_id, outcome, explicit, received_at, seen) VALUES (?, 'pixiv', ?, ?, 'collected', ?, ?, ?)");
  const addPage = db.prepare("INSERT INTO received_page (library_id, source, work_id, page, image_id, received_at) VALUES (?, 'pixiv', ?, 0, ?, ?)");
  imageIds.forEach((imageId, i) => {
    const at = now - i * 3_600_000;
    addWork.run(info.id, `w${i}`, owners[i], i === 2 || i === 8 ? 1 : 0, at, i < 5 ? 0 : 1);
    addPage.run(info.id, `w${i}`, imageId, at);
  });
  db.close();
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  // 打开前图标轨上的新图数。
  await session.shot("00-rail-badge-light.png");
  await openSubscriptions(); await delay(1500);
  // 新装时安全模式开着：先截安全模式，再关掉看全部。
  await session.shot("03-safe-mode-light.png");
  await theme("dark"); await settle();
  await session.shot("03-safe-mode-dark.png");
  await theme("light");
  await toggleSafe();
  await session.shot("01-subscriptions-light.png");
  await theme("dark"); await settle();
  await session.shot("02-subscriptions-dark.png");
  await theme("light"); await settle();
  await session.click("//aside//button[@aria-label='账号']"); await settle();
  await session.shot("12-account-menu-light.png");
  await escape(); await settle();
  await openSettingsTab();
  await session.shot("13-settings-on-light.png");
  await theme("dark"); await settle();
  await session.shot("13-settings-on-dark.png");
  await theme("light");
  await session.click("//*[@role='switch' and @aria-label='订阅功能']"); await delay(1200);
  await session.shot("14-settings-off-light.png");
  await session.click("//*[@role='switch' and @aria-label='订阅功能']"); await delay(1200);
  await escape(); await settle();

  // 限流退避中。
  await session.close(); quitOwnApp(); await delay(800);
  const backoff = new DatabaseSync(join(subsDir, "subscriptions.db"));
  backoff.prepare("INSERT OR REPLACE INTO backoff (source, until, level) VALUES ('pixiv', ?, 1)").run(Date.now() + 40 * 60_000);
  backoff.close();
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await openSubscriptions();
  await session.shot("10-backoff-light.png");
  await theme("dark"); await settle();
  await session.shot("10-backoff-dark.png");

  // 登录失效（检查已暂停，不联网）。
  await session.close(); quitOwnApp(); await delay(800);
  const reset = new DatabaseSync(join(subsDir, "subscriptions.db"));
  reset.prepare("DELETE FROM backoff").run();
  reset.close();
  writeFileSync(join(subsDir, "pixiv-account.json"), JSON.stringify({ refreshToken: "example-not-a-real-token", account: { name: "yuki_sub", explicitAllowed: true }, expired: true }));
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await openSubscriptions();
  await session.shot("11-expired-light.png");
  await theme("dark"); await settle();
  await session.shot("11-expired-dark.png");
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
