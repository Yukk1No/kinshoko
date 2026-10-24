// #180: app-window screenshots of the multi-select Dock bar and the collapsing bottom-right corner at three
// wall widths, a frame sequence of the bar appearing and leaving, and the reduced-motion end state.
// Usage: node e2e/selection-bar-180.mjs <kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg] = process.argv;
if (!appArg || !edgeArg) throw new Error("Usage: node e2e/selection-bar-180.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `selection-bar-180-${Date.now()}`);
mkdirSync(join(work, "frames"), { recursive: true });
const port = 4568;
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
/** A synthetic gradient picture: two colours mixed along the diagonal. */
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
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async click(xpath) {
    return until("click " + xpath, async () => {
      const id = (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT];
      await wd("POST", `${this.base}/element/${id}/click`, {});
      return true;
    });
  }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  close() { return wd("DELETE", this.base); }
  async shot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
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
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]], [[239, 71, 111], [255, 209, 102]], [[73, 80, 87], [173, 181, 189]]];
const sizes = [[240, 320], [320, 240], [240, 240], [200, 340], [320, 200], [260, 300], [300, 260], [220, 300]];
const settle = () => delay(900);
/** Ctrl+click a card the way the wall reads it (onClick with ctrlKey). */
const pick = (id, ctrl) => session.exec("const el = document.querySelector(`[data-id=\"${arguments[0]}\"]`); el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: arguments[1] })); return true;", [id, ctrl]);
const clearSelection = () => session.exec("const b = document.querySelector('[role=toolbar][aria-label=已选参考图操作] [aria-label=取消选择]'); b?.click(); return !!b;");
const layout = () => session.exec(`
  const host = document.querySelector('.wall-host').getBoundingClientRect();
  const bar = document.querySelector('.selbar-float')?.getBoundingClientRect();
  const corner = document.querySelector('.k-wall-corner').getBoundingClientRect();
  const cornerHidden = document.querySelector('.k-wall-corner').getAttribute('aria-hidden') === 'true';
  return { wall: host.width, bar: bar && { left: bar.left - host.left, right: bar.right - host.left }, corner: { left: corner.left - host.left, right: corner.right - host.left }, cornerHidden,
    overlap: !!bar && !cornerHidden && bar.right > corner.left && bar.left < corner.right, overflow: !!bar && (bar.left < host.left || bar.right > host.right) };`);
const results = {};
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent);
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.invoke("start_import", { libraryId: info.id, source: { paths } });
  await until("import", async () => (await session.invoke("workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true })).total === paths.length);
  const people = await session.invoke("create_folder", { libraryId: info.id, name: "人物", parent: null });
  await session.invoke("create_folder", { libraryId: info.id, name: "姿势", parent: people });
  await session.invoke("create_folder", { libraryId: info.id, name: "配色", parent: null });
  await session.close(); quitOwnApp(); await delay(800);
  session = await Session.start();
  await until("wall", () => session.exec(`return document.querySelector('.wall')?.dataset.total === '${paths.length}';`));
  await session.rect({ width: 1440, height: 900 });
  await settle();
  const ids = await session.exec("return [...document.querySelectorAll('.wall [data-id]')].map(el => el.dataset.id);");
  // The tagging model is not downloaded in this fixture: close the bottom-right notice so it does not cover the corner.
  await until("notices closed", async () => { await session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;"); await delay(400); return session.exec("return !document.querySelector('.k-toast-close');"); });

  // 1. Wide window, one selected: no bar, corner as before. Then collapse the detail panel and multi-select.
  await pick(ids[0], false); await settle();
  await session.shot("1-single-wide.png");
  results.single = await layout();
  await pick(ids[1], true); await pick(ids[2], true); await settle();
  await session.click("//button[@aria-label='收起详情']"); await settle();
  await session.shot("2-multi-wide.png");
  results.wide = await layout();
  // Folder menu opens upward from the dock.
  await session.click("//*[@role='toolbar' and @aria-label='已选参考图操作']//button[@aria-label='移到文件夹']"); await settle();
  await session.shot("3-multi-folder-menu.png");
  await session.exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.activeElement?.blur(); return true;");
  await settle();
  // The collapsed size button pops the slider out on press.
  await session.click("//*[@role='group' and @aria-label='图片大小']//button[@aria-label='图片大小']"); await settle();
  await session.shot("4-multi-size-popover.png");
  await session.exec("document.activeElement?.blur(); document.querySelector('.k-density-island')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); return true;");

  // 2. Detail panel open (wall narrower): a new selection opens the panel again.
  await clearSelection(); await settle();
  await pick(ids[3], false); await pick(ids[4], true); await pick(ids[5], true); await settle();
  await session.shot("5-multi-inspector.png");
  results.inspector = await layout();

  // 3. Narrow window: wall under 600 px.
  await session.rect({ width: 1000, height: 820 }); await settle();
  await session.shot("6-multi-narrow.png");
  results.narrow = await layout();
  await session.rect({ width: 860, height: 820 }); await settle();
  await session.shot("7-multi-narrowest.png");
  results.narrowest = await layout();

  // 4. Motion: frames while the bar rises and while it leaves (wide window, detail panel open).
  await session.rect({ width: 1440, height: 900 }); await clearSelection(); await settle();
  await pick(ids[6], false); await settle();
  const frames = async (prefix, act) => {
    await act();
    const start = Date.now(); let n = 0;
    while (Date.now() - start < 1100) { await session.shot(join("frames", `${prefix}-${String(n++).padStart(2, "0")}.png`)); }
    return n;
  };
  results.framesIn = await frames("in", () => pick(ids[7], true));
  await settle();
  results.framesOut = await frames("out", () => clearSelection());

  // 5. Reduced motion: the end state right after selecting, no animation.
  await session.exec("document.documentElement.setAttribute('data-reduced-motion', ''); return true;");
  await pick(ids[0], false); await delay(200);
  await pick(ids[1], true); await pick(ids[2], true); await delay(60);
  await session.shot("8-reduced-motion.png");
  results.reduced = await layout();
  writeFileSync(join(work, "result.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
