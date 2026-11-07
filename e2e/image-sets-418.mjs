// #418 第 2 步：图片墙叠放图集与原位托盘的日间、夜间截图，可选录屏（悬停拿起、打开托盘、关上托盘）。
// 应用要用 VITE_KINSHOKO_STACK_SETS=1 构建（第 3 步合并前，叠放只在开发构建或这个开关下露出）。
// 墙上的图来自一个合成的 Eagle 资料库：几个 pixiv 多页作品（链接是作品页、文件名带 _p<n>），夹着普通单张。
// 录屏用 ffmpeg 按窗口标题抓屏，窗口必须在前台、不被挡住：加 --record 才录，会占用屏幕。
// Usage: node e2e/image-sets-418.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录> [--record]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg, ...flags] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/image-sets-418.mjs <kinshoko.exe> <msedgedriver.exe> <out> [--record]");
const record = flags.includes("--record");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4618;
const driverUrl = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

// ---- 合成的 Eagle 资料库 ----
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
};
/** 合成图：两种颜色沿对角线渐变，中间一块亮斑，同一作品的各页色相相近。 */
function png(width, height, hue, page) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const [a, b, c] = [hsl(hue, 0.45, 0.62), hsl((hue + 30) % 360, 0.38, 0.36), hsl((hue + 40) % 360, 0.5, 0.85)];
  const cx = 0.35 + (page % 3) * 0.15, cy = 0.4;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const d = Math.hypot(x / width - cx, (y / height - cy) * 1.3);
      const glow = Math.max(0, 1 - d / 0.28);
      for (let k = 0; k < 3; k++) row[1 + x * 3 + k] = Math.round((a[k] * (1 - t) + b[k] * t) * (1 - glow) + c[k] * glow);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
/** 作品：页数、首页比例（高 / 宽）与各页比例的偏差，与纸张对比原型的那一批相同。 */
const WORKS = [
  { id: "91000001", ratio: 1.0, vary: [0, 0], hue: 140 },
  { id: "91000002", ratio: 0.72, vary: [0, 0.12, 0], hue: 275 },
  { id: "91000003", ratio: 1.414, vary: [0, 0.14, -0.12, 0, 0.1, 0], hue: 205 },
  { id: "91000004", ratio: 1.42, vary: [0, 0, 0.18, 0.12, 0, 0, -0.2, 0, 0, 0, 0.24, 0], hue: 22 },
  { id: "91000005", ratio: 1.6, vary: [0, -0.16, 0.12, 0], hue: 340 },
  { id: "91000006", ratio: 0.56, vary: [0, 0.1, 0, -0.06, 0], hue: 50 },
];
const SINGLE_RATIOS = [0.66, 0.75, 1, 1.25, 1.33, 1.414, 1.5, 0.56, 1.2, 0.8, 1.1, 1.6];
const ORDER = "s A s B C s D s s E F s s s s s".split(" ");
const eagle = join(work, "fixture", "示例.library");
mkdirSync(join(eagle, "images"), { recursive: true });
writeFileSync(join(eagle, "metadata.json"), JSON.stringify({ folders: [], applicationVersion: "4.0.0" }));
let serial = 0;
let btime = 1756571097667;
function item({ name, width, height, hue, page, url }) {
  const id = `ITEM${String(serial++).padStart(9, "0")}`;
  const dir = join(eagle, "images", `${id}.info`);
  mkdirSync(dir, { recursive: true });
  const bytes = png(width, height, hue, page);
  writeFileSync(join(dir, `${name}.png`), bytes);
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({
    id, name, ext: "png", size: bytes.length, width, height, tags: [], folders: [], annotation: "", url, isDeleted: false,
    btime: btime += 60_000, comments: [],
  }));
}
{
  let single = 0, work = 0;
  for (const token of ORDER) {
    if (token === "s") {
      const ratio = SINGLE_RATIOS[single % SINGLE_RATIOS.length];
      item({ name: `single-${++single}`, width: 360, height: Math.round(360 * ratio), hue: (single * 47) % 360, page: single, url: "" });
    } else {
      const w = WORKS[work++];
      w.vary.forEach((v, p) => item({
        name: `${w.id}_p${p}`, width: 360, height: Math.round(360 * w.ratio * (1 + v)), hue: w.hue + (p % 3) * 9 - 9, page: p,
        url: `https://www.pixiv.net/artworks/${w.id}`,
      }));
    }
  }
}

// --fixture-only：只生成 Eagle 资料库就退出（不启动应用，不占屏幕），用来检查数据。
if (flags.includes("--fixture-only")) { console.log(`Fixture: ${eagle} (${serial} items)`); process.exit(0); }

// ---- WebDriver ----
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
  async element(css) { return until("find " + css, async () => (await wd("POST", `${this.base}/element`, { using: "css selector", value: css }))[ELEMENT]); }
  async click(css) { await wd("POST", `${this.base}/element/${await this.element(css)}/click`, {}); }
  /** 真实的指针动作：移到元素中心（可带偏移），按住修饰键单击。 */
  async pointer(css, { click = false, ctrl = false, dx = 0, dy = 0, button = 0 } = {}) {
    const id = await this.element(css);
    const actions = [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", origin: { [ELEMENT]: id }, x: dx, y: dy, duration: 120 },
      ...(click ? [{ type: "pointerDown", button }, { type: "pointerUp", button }] : []),
    ] }];
    if (ctrl) actions.unshift({ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "" }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: "" }] });
    await wd("POST", `${this.base}/actions`, { actions });
    await wd("DELETE", `${this.base}/actions`);
  }
  key(value) { return wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }] }); }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  /** 指针移到窗口左下角，不停在任何一格上。 */
  park() { return wd("POST", `${this.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 120, y: 880 }] }] }); }
  close() { return wd("DELETE", this.base); }
  async theme(name) { await this.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]); await delay(500); }
  async shot(name) {
    for (const theme of ["light", "dark"]) {
      await this.theme(theme);
      writeFileSync(join(work, `${name}-${theme === "light" ? "day" : "night"}.png`), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64"));
    }
    await this.theme("light");
    console.log("shot", name);
  }
}
function quitOwnApp() {
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore", windowsHide: true });
}
/** 录一段：ffmpeg 抓 Kinshoko 窗口，跑完 act 后再多录一会儿。 */
async function clip(name, act, tail = 900) {
  if (!record) { await act(); return; }
  const file = join(work, `${name}.mp4`);
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "60", "-draw_mouse", "1", "-i", "title=Kinshoko",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", file], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  await delay(700);
  try { await act(); await delay(tail); } finally {
    ffmpeg.stdin.write("q"); ffmpeg.stdin.end();
    await new Promise((done) => ffmpeg.on("exit", done));
  }
  console.log("clip", name);
}

const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const settle = () => delay(900);
const closeToasts = () => until("notices closed", async () => {
  await session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;"); await delay(400);
  return session.exec("return !document.querySelector('.k-toast-close');");
});
/** 第 n 摞（墙上的顺序）的封面选择器；按张数找，免得依赖卡片 id。 */
const stack = (pages) => session.exec(`const count = [...document.querySelectorAll('.wall-canvas > .card-count')].find(b => b.textContent.trim() === String(arguments[0]));
  if (!count) return null; const id = count.dataset.card; return '.card[data-id="' + id + '"]';`, [pages]);
const countButton = (pages) => session.exec(`const count = [...document.querySelectorAll('.wall-canvas > .card-count')].find(b => b.textContent.trim() === String(arguments[0]));
  return count ? '.card-count[data-card="' + count.dataset.card + '"]' : null;`, [pages]);
/** 让这一摞停在视口上部三分之一处。 */
const reveal = (css) => session.exec(`const el = document.querySelector(arguments[0]); const wall = document.querySelector('.wall');
  wall.scrollTop += el.getBoundingClientRect().top - wall.getBoundingClientRect().top - wall.clientHeight / 4; return true;`, [css]);
const failures = [];
/** 一步失败只记下来，后面的照常截。 */
async function step(label, run) {
  try { await run(); } catch (error) { failures.push(`${label}: ${error.message}`); console.log("FAILED", label, error.message); try { await session.key(""); await session.key(""); } catch {} }
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ x: 40, y: 40, width: 1440, height: 900 });
  await until("empty wall", () => session.exec("return Boolean(document.querySelector('.wall-empty'));"));
  await session.invoke("start_import", { libraryId: info.id, source: { paths: [eagle] } });
  await until("stacks on the wall", () => session.exec("return document.querySelectorAll('.wall-canvas > .card-count').length >= 4;"), 60000);
  await settle(); await closeToasts().catch(() => {}); await session.park(); await settle(); await settle();

  await step("wall at rest", () => session.shot("01-wall"));
  await step("hover a stack", async () => {
    const six = await stack(6); await reveal(six); await settle();
    await session.pointer(six); await delay(700);
    await session.shot("02-hover");
    await session.park(); await settle();
  });
  await step("select a stack", async () => {
    const six = await stack(6);
    await session.pointer(six, { click: true }); await session.park(); await settle();
    await session.shot("03-stack-selected");
  });
  await step("open the tray", async () => {
    await session.click(await countButton(6));
    await until("tray", () => session.exec("return Boolean(document.querySelector('.wall-tray'));"), 5000);
    await session.park(); await settle();
    await session.shot("04-tray-open");
  });
  await step("select pages in the tray", async () => {
    const pages = await session.exec("return [...document.querySelectorAll('.wall-canvas > .card.is-tray-page')].map(n => '.card[data-id=\"' + n.dataset.id + '\"]');");
    await session.pointer(pages[1], { click: true });
    await session.pointer(pages[3], { click: true, ctrl: true });
    await session.pointer(pages[4], { dx: 10, dy: 10 }); await delay(400);
    await session.shot("05-tray-pages-selected");
  });
  await step("close the tray with Esc", async () => {
    await session.key(""); await session.key("");
    await until("tray closed", () => session.exec("return !document.querySelector('.wall-tray');"), 5000);
    await session.park(); await settle();
  });
  await step("twelve-page tray", async () => {
    const twelve = await countButton(12); await reveal(twelve); await settle();
    await session.click(twelve); await session.park(); await settle();
    await session.shot("06-tray-twelve-pages");
    await session.key(""); await settle();
  });
  await step("wall menu", async () => {
    // 墙左边的内边距里没有卡片：在那里右键是空白处的菜单。
    await session.exec("const wall = document.querySelector('.wall'); const r = wall.getBoundingClientRect(); wall.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + r.height / 2 })); return true;");
    await until("menu", () => session.exec("return Boolean([...document.querySelectorAll('[role=menuitemcheckbox]')].find(x => x.textContent.includes('叠放图集')));"), 5000);
    await settle(); await session.shot("07-wall-menu");
    await session.key(""); await settle();
  });

  // 录屏：日间、夜间各一段，依次是悬停拿起、打开托盘、点托盘下面的一格关上托盘。
  for (const theme of ["light", "dark"]) {
    await step(`clip ${theme}`, async () => {
      await session.theme(theme);
      const six = await stack(6); await reveal(six); await session.park(); await settle();
      await clip(`clip-${theme === "light" ? "day" : "night"}`, async () => {
        await session.pointer(six); await delay(900);
        await session.park(); await delay(600);
        await session.click(await countButton(6)); await delay(1200);
        const below = await session.exec(`const tray = document.querySelector('.wall-tray').getBoundingClientRect();
          const node = [...document.querySelectorAll('.wall-canvas > .card:not(.is-tray-page)')].find(n => { const r = n.getBoundingClientRect(); return r.top > tray.bottom && r.bottom < innerHeight; });
          return node ? '.card[data-id="' + node.dataset.id + '"]' : null;`);
        if (below) await session.pointer(below, { click: true }); else await session.key("");
        await delay(400); await session.park();
      });
      await session.key(""); await settle();
    });
  }
  await session.theme("light");
  console.log(`Evidence: ${work}`);
} finally {
  if (failures.length) { console.log("Failed steps:"); for (const f of failures) console.log(" - " + f); }
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
