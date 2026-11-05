// 订阅收进来的图在详情侧栏里的样子（日间与夜间）：图不在窗口打开的图库里时，详情侧栏直接显示这张图的标签、分级、
// 文件夹与备注；同一张图在两个图库时，顶上切换图库。数据：先建「pixiv 榜单」导入带作者与 pixiv 标签的图，再建 Test
// 并留在 Test（与订阅榜单默认新建、不切换过去相同）。不访问 pixiv。
// Usage: node e2e/inspector-sources.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/inspector-sources.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
const data = join(work, "app-data");
mkdirSync(work, { recursive: true });
const port = 4602;
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
const pick = (id) => session.exec("document.querySelector(`.card[data-id=\"${arguments[0]}\"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;", [id]);
// 详情面板是普通面板：没有操作栏、“已选 1 张”和“复制到…”（#425）。
const plainPanel = async (label) => {
  const leftover = await session.exec("const panel = document.querySelector('aside.inspector'); return { text: panel?.innerText ?? '', bar: Boolean(panel?.querySelector('[role=toolbar]')) };");
  if (!leftover.text || leftover.bar || /已选 1 张|复制到…/.test(leftover.text)) throw new Error(`${label}: ${JSON.stringify(leftover)}`);
  console.log("plain panel", label);
};
const named = (namespace, name) => ({ kind: "add", tag: { kind: "named", namespace, name, lang: "ja" } });

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
  // 最后一张图两个库都有。
  const ranking = await load("pixiv 榜单", paths.slice(5));
  const imageOf = (page, i) => { const card = page.cards.find((c) => c.width === sizes[i][0] && c.height === sizes[i][1]); return card; };
  const featured = imageOf(ranking.page, 5);
  const shared = imageOf(ranking.page, 9);
  await session.invoke("plugin:library|edit_tags", { libraryId: ranking.info.id, imageIds: [featured.imageId, shared.imageId], edits: [
    named("artist", "ミナト"), named("general", "オリジナル"), named("general", "女の子"), named("general", "桜"), named("general", "制服"), named("general", "黒髪ロング"),
  ] });
  await load("Test", [...paths.slice(0, 5), paths[9]]);
  await restart();

  // B 只在「pixiv 榜单」里的图：详情直接是这张图。
  await pick(featured.id); await settle();
  await both("B-single-library");
  // 进查看器，侧栏照样是这张图的详情。
  await session.exec("const el = document.querySelector(`.card[data-id=\"${arguments[0]}\"]`); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;", [featured.id]);
  await until("viewer", () => session.exec("return Boolean(document.querySelector('.viewer'));"));
  await settle(); await delay(800);
  await both("B2-viewer");
  await escape(); await settle();

  // C 两个图库都有：顶上切换到另一个图库。
  await pick(shared.id); await settle();
  await plainPanel("C1");
  await both("C1-two-libraries");
  await session.click("//aside//*[@role='group' and @aria-label='所在图库']//button[not(@aria-pressed='true')]"); await settle();
  await plainPanel("C2");
  await both("C2-switched");

  // D 查看器打开墙外的图：窗口留在 Test，打开只在「pixiv 榜单」里的图。真实入口是钉图菜单“在 Kinshoko 中打开”，
  // 这里替换它取请求的那一步，不弹钉图窗口；之后的路径与真实入口相同。
  await session.click("//button[starts-with(@aria-label, 'Test') or starts-with(normalize-space(), 'Test')]"); await settle();
  await until("Test wall without the image", () => session.exec("return document.querySelectorAll('.card[data-id]').length === 6 && !document.querySelector(`.card[data-id=\"${arguments[0]}\"]`);", [featured.id]));
  await session.exec("const internals = window.__TAURI_INTERNALS__, invoke = internals.invoke, request = arguments[0]; internals.invoke = (command, ...rest) => command === 'plugin:desktop|take_open_request' ? Promise.resolve(request) : invoke(command, ...rest); return true;", [{ kind: "reference", libraryId: ranking.info.id, imageId: featured.imageId }]);
  await session.invoke("plugin:event|emit", { event: "open-in-kinshoko", payload: null });
  await until("viewer outside the wall", () => session.exec("return Boolean(document.querySelector('.viewer'));"));
  await settle(); await delay(800);
  await plainPanel("D");
  await both("D-viewer-outside-wall");
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
