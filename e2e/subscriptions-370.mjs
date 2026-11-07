// #370：订阅榜单在真实应用里的关键页面（日间与夜间）：第一次订榜单的对话框（新建「pixiv 榜单」）、
// 勾上 R-18 榜、已有榜单订阅时换图库的提示、榜单的订阅设置、名单与安全模式（R-18 榜照常列出，R-18 图不上屏）。
// 数据准备同 subscriptions-369.mjs：假账号、不到期的订阅，不访问 pixiv。不点“订阅”“保存”（会马上检查，请求 pixiv）。
// 「pixiv 榜单」图库用 create_library_unopened 建（不切换过去），顺带验证它。
// Usage: node e2e/subscriptions-370.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/subscriptions-370.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
const data = join(work, "app-data");
const subsDir = join(data, "subscriptions");
mkdirSync(work, { recursive: true });
const port = 4596;
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
  env: { ...process.env, KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
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
const openRankingDialog = async () => {
  await session.click("//aside//button[@aria-label='添加订阅']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '榜单')]"); await settle();
};
const account = (expired) => writeFileSync(join(subsDir, "pixiv-account.json"),
  JSON.stringify({ refreshToken: "example-not-a-real-token", account: { userId: "9", name: "yuki_sub", explicitAllowed: true }, expired }));
const reopen = async () => {
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await openSubscriptions(); await delay(1500);
};
const DAILY = "//aside//button[contains(@class, 'subs-row') and contains(., '日榜 前 50') and not(contains(., 'R-18'))]";

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "参考图"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("plugin:library|create_library", { parent, name: "主图库" });
  await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths } });
  const browse = () => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const page = await until("import", async () => { const p = await browse(); return p.total === paths.length && p; });
  const imageIds = page.cards.map((card) => card.imageId ?? card.id);

  // 先让应用建好订阅记录，再写入示例：登录着的假账号，两位画师，都在 10 分钟前查过，不到期。
  await restart();
  await session.close(); quitOwnApp(); await delay(800);
  mkdirSync(subsDir, { recursive: true });
  account(false);
  const now = Date.now();
  let db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  const prepare = () => ({
    addSub: db.prepare("INSERT INTO subscription (id, source, target, name, library_id, include_explicit, include_manga, created_at, last_checked_at, backlog, since) VALUES (?, 'pixiv', ?, ?, ?, 1, 0, ?, ?, ?, ?)"),
    addWork: db.prepare("INSERT INTO received_work (library_id, source, work_id, subscription_id, outcome, explicit, received_at, seen) VALUES (?, 'pixiv', ?, ?, 'collected', ?, ?, ?)"),
    addPage: db.prepare("INSERT INTO received_page (library_id, source, work_id, page, image_id, received_at) VALUES (?, 'pixiv', ?, 0, ?, ?)"),
  });
  let { addSub, addWork, addPage } = prepare();
  [["s1", "1001", "Mika"], ["s2", "1002", "ぽち"]].forEach(([id, userId, name], i) =>
    addSub.run(id, JSON.stringify({ kind: "pixivArtist", userId }), name, info.id, now - 86_400_000 + i, now - 10 * 60_000, JSON.stringify({ kind: "newOnly" }), now - 86_400_000));
  const receive = (owners, explicit = []) => imageIds.forEach((imageId, i) => {
    const at = now - i * 3_600_000;
    addWork.run(info.id, `w${i}`, owners[i], explicit.includes(i) ? 1 : 0, at, i < 4 ? 0 : 1);
    addPage.run(info.id, `w${i}`, imageId, at);
  });
  receive(["s1", "s1", "s2", "s1", "s2", "s2", "s1", "s2", "s1", "s1", "s1", "s2"]);
  db.close();

  await reopen();
  // 新装时安全模式开着：先关掉。
  await toggleSafe();

  // A 第一次订榜单：预勾日榜前 50，默认在当前图库旁边新建「pixiv 榜单」。
  await openRankingDialog();
  await both("A1-first-ranking");
  // 勾上 R-18 日榜，周榜选前 10（点名次顺带勾上），改放进已有图库。
  await session.click("//*[@role='dialog']//label[contains(., 'R-18 日榜')]"); await settle();
  await session.click("//*[@role='dialog']//*[@aria-label='周榜同步前几名']//button[contains(., '前 10')]"); await settle();
  await session.click("//*[@role='dialog']//label[contains(., '放进已有图库')]//input"); await settle();
  await both("A2-picked-existing-library");
  await escape(); await settle();

  // 建「pixiv 榜单」图库（不切换过去），写入榜单订阅：日榜前 50 与 R-18 日榜前 10，收进来的图里有 R-18 的。
  const rankingsLibrary = await session.invoke("plugin:library|create_library_unopened", { parent, name: "pixiv 榜单" });
  const current = await session.invoke("plugin:library|current_library");
  if (current.id !== info.id) throw new Error("create_library_unopened switched the current library");
  await session.close(); quitOwnApp(); await delay(800);
  db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  ({ addSub, addWork, addPage } = prepare());
  db.exec("DELETE FROM received_page; DELETE FROM received_work;");
  const ranking = (id, period, top, explicit, name, i) => addSub.run(id, JSON.stringify({ kind: "pixivRanking", period, top, explicit }), name,
    rankingsLibrary.id, now - 3_600_000 + i, now - 10 * 60_000, JSON.stringify({ kind: "all" }), null);
  ranking("r1", "day", 50, false, "日榜 前 50", 0);
  ranking("r2", "day", 10, true, "R-18 日榜 前 10", 1);
  // 示例图都在主图库里（只为有缩略图可看）；作品 1、5、9 是 R-18 日榜收的 R-18 图。
  receive(["r1", "r2", "s1", "r1", "s2", "r2", "r1", "s2", "r1", "r2", "s1", "r1"], [1, 5, 9]);
  db.close();

  // 安全模式在第一轮已经关掉，设置会留着。
  await reopen();

  // B 名单：画师下面是榜单两行；选中日榜看它收进来的图。
  await both("B1-list");
  await session.click(DAILY); await park(); await settle();
  await both("B2-daily-selected");

  // C 已有榜单订阅时：日榜与 R-18 日榜标“已订阅”，图库默认「pixiv 榜单」；换成主图库时提示可能重复收。
  await openRankingDialog();
  await both("C1-existing-rankings");
  await session.click("//*[@role='dialog']//*[@role='combobox']"); await settle();
  await session.click("//*[@role='option' and contains(., '主图库')]"); await settle();
  await both("C2-other-library");
  await escape(); await settle();

  // D 榜单的订阅设置：名次与漫画。
  await hover(DAILY); await settle();
  await session.click("//aside//div[contains(@class, 'subs-row-wrap') and .//button[contains(., '日榜 前 50') and not(contains(., 'R-18'))]]//button[@aria-label='更多']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '订阅设置')]"); await settle();
  await session.click("//*[@role='dialog']//button[contains(., '前 100')]"); await settle();
  await both("D-settings");
  await session.click("//*[@role='dialog']//button[contains(., '取消')]"); await settle();

  // E 安全模式开着：R-18 日榜照常列着，它收的 R-18 图不上屏；对话框里照常有 R-18 选项。
  await session.click("//aside//button[contains(@class, 'is-all')]"); await park(); await settle();
  await toggleSafe();
  await both("E1-safe-mode-list");
  await openRankingDialog();
  await both("E2-safe-mode-dialog");
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
