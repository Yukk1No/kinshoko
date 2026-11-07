// #444：详情面板只由画师开合。日间与夜间各截一张：新装默认关着时单击选中、顶栏按钮打开、多选跨图库时的空面板、
// 右键菜单里的“详情”勾选项。数据：两个图库各导入几张合成图，在“全部图片”下操作。
// Usage: node e2e/inspector-on-demand-444.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/inspector-on-demand-444.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
const data = join(work, "app-data");
mkdirSync(work, { recursive: true });
const port = 4612;
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
async function restart() {
  await session.close(); quitOwnApp(); await delay(800);
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
}

const palette = [[[233, 196, 106], [42, 157, 143]], [[244, 162, 97], [38, 70, 83]], [[231, 111, 81], [233, 196, 106]], [[131, 56, 236], [58, 134, 255]],
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]], [[239, 71, 111], [255, 209, 102]], [[118, 120, 237], [247, 184, 1]],
  [[140, 179, 105], [244, 226, 133]], [[93, 46, 140], [204, 102, 218]]];
const sizes = [[240, 330], [320, 230], [250, 250], [220, 360], [320, 210], [260, 300], [240, 280], [300, 240], [230, 340], [280, 260]];
const both = async (name) => {
  await theme("light"); await settle(); await session.shot(`${name}-light.png`);
  await theme("dark"); await settle(); await session.shot(`${name}-dark.png`);
  await theme("light"); await settle();
};
const pick = (id, ctrlKey = false) => session.exec("document.querySelector(`.card[data-id=\"${arguments[0]}\"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: arguments[1] })); return true;", [id, ctrlKey]);
const panel = () => session.exec("const p = document.querySelector('aside.inspector'); return { open: p?.dataset.collapsed === 'false', content: p?.querySelector('.insp-body')?.childElementCount ?? 0, wall: document.querySelector('.wall').getBoundingClientRect().width };");
const check = (ok, label) => { if (!ok) throw new Error(label); console.log("ok", label); };
const rightClick = (id) => session.exec(`const el = document.querySelector('.card[data-id="' + arguments[0] + '"]'); const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true;`, [id]);

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "Test"); mkdirSync(parent, { recursive: true });
  const browse = (libraryId) => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "library", libraryId, scope: { kind: "all" } }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const load = async (name, files) => {
    const info = await session.invoke("plugin:library|create_library", { parent, name });
    await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths: files } });
    const page = await until("import " + name, async () => { const p = await browse(info.id); return p.total === files.length && p; });
    return { info, page };
  };
  const ranking = await load("pixiv 榜单", paths.slice(5, 9));
  const test = await load("Test", paths.slice(0, 5));
  await restart();
  // “全部图片”下两个图库的图都在墙上。
  await session.click("//nav[@aria-label='查找范围']//button[starts-with(@aria-label,'全部图片')]"); await settle();
  await until("all images", () => session.exec("return document.querySelectorAll('.card[data-id]').length === 9;"));
  const all = await session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const inLibrary = (libraryId) => all.cards.find((c) => c.sources?.length === 1 && c.sources[0].libraryId === libraryId).id;
  const a = inLibrary(test.info.id), b = inLibrary(ranking.info.id);

  // 1. 新装默认关着：单击只选中，图片墙宽度不变。
  const before = await panel();
  check(!before.open, "新装时详情面板关着");
  await pick(a); await settle();
  const closed = await panel();
  check(!closed.open && closed.content === 0 && Math.abs(closed.wall - before.wall) < 1, "单击只选中，面板不开、不读详情，图片墙宽度不变");
  await both("1-closed-selected");

  // 2. 顶栏“显示详情”打开。
  await session.click("//button[@aria-label='显示详情']"); await settle();
  const shown = await panel();
  check(shown.open && shown.content > 0, "顶栏按钮打开面板，显示选中的图");
  await both("2-opened-by-topbar");

  // 3. 多选跨图库：内容留空、宽度不变。
  await pick(b, true); await settle();
  const multi = await panel();
  check(multi.open && multi.content === 0 && Math.abs(multi.wall - shown.wall) < 1, "多选跨图库时面板开着、内容留空、宽度不变");
  await both("3-multi-cross-library");

  // 4. 右键菜单里的“详情”勾选项。
  await pick(a); await settle();
  await rightClick(a); await settle();
  check(await session.exec("return [...document.querySelectorAll('[role=menuitemcheckbox]')].some(m => m.textContent.includes('详情') && m.getAttribute('aria-checked') === 'true');"), "右键菜单有勾上的“详情”");
  await both("4-card-menu");
  await escape(); await settle();
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
