// #120 / #121 / #123：在真实应用里导入同一批合成样本，并测量导入、导入中的侧栏与图片墙缩略图。
//
// 用法（PowerShell，先构建带探针的版本：$env:VITE_KINSHOKO_PERF="1"; npm run tauri build -- --no-bundle）：
//   node scripts/perf/wall-fixture.mjs <样本目录> 5000 1
//   node e2e/import-wall-perf.mjs <kinshoko.exe> <与 WebView2 同版本的 msedgedriver.exe> <样本目录> [轮数=3]
//
// 步骤：建库 A（导入目标）与库 B（4 张图）→ 计时导入样本到 A，期间观察侧栏资料库行的 DOM 节点是否被替换、
// 是否短暂变成不可用（#121），并在导入中切换浏览范围、在 B 新建文件夹 → 窗口最大化、浏览 A 的全部图片 →
// 每轮先跑一次缩略图替换时间（#123），再跑一次帧时间（不挂观察器）。替换时间放在前面：同一轮里后跑的
// 那一项滚过的是前一项刚取过的缩略图，替换时间不能借这份预热；帧时间与缩略图是否已缓存关系不大。
// 数据目录与 WebView2 配置都在 work/e2e/ 下的新目录里，不碰本设备的正式资料库。
// 结果写到该目录的 result.json；截图只截应用窗口（WebDriver 截的是 WebView 内容）。

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, samplesArg, roundsArg] = process.argv;
if (!appArg || !edgeArg || !samplesArg) {
  console.error("用法：node e2e/import-wall-perf.mjs <kinshoko.exe> <msedgedriver.exe> <样本目录> [轮数=3]");
  process.exit(2);
}
const application = resolve(appArg);
const samples = resolve(samplesArg);
const rounds = Number(roundsArg ?? 3);
// 样本里可能有字节相同的图（同库只进一张）：按生成器写下的 SHA-256 数出应当进库的张数，导入后逐张核对。
const fixture = JSON.parse(readFileSync(join(samples, "fixture.json"), "utf8"));
const expected = new Set(fixture.images.map((image) => image.sha256)).size;
const work = resolve("work", "e2e", `import-wall-perf-${Date.now()}`);
mkdirSync(work, { recursive: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
const port = Number(process.env.KINSHOKO_PERF_PORT ?? 4460);
const driverUrl = `http://127.0.0.1:${port}`;

function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const small = join(work, "b-images");
mkdirSync(small);
[[200, 80, 80], [80, 200, 80], [80, 80, 200], [200, 200, 80]].forEach((colour, i) => writeFileSync(join(small, `b-${i}.png`), png(64, 48 + i * 8, colour)));

async function wd(method, path, body) {
  const response = await fetch(driverUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value).slice(0, 400)}`);
  return result.value;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, read, timeout = 30000, every = 150) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (reason) { error = reason; }
    await delay(every);
  }
  throw new Error(`等待超时：${label}${error ? `（${error.message}）` : ""}`);
}
class Session {
  static async start() {
    const value = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
    const session = new Session(value.sessionId);
    await until("Tauri IPC", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async run(script, args = []) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then(value => done({ value }), error => done({ failure: String(error?.stack ?? error) }));`, args });
    if (result?.failure) throw new Error(result.failure);
    return result.value;
  }
  invoke(command, args = {}) { return this.run("return await window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]);", [command, args]); }
  async screenshot(file) { writeFileSync(file, Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}

const result = { application, samples, expected, rounds, startedAt: new Date().toISOString() };
const save = () => writeFileSync(join(work, "result.json"), JSON.stringify(result, null, 2));
const driver = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
});
let session;
try {
  await until("tauri-driver", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  // WebDriver 的 maximize 对 Tauri 窗口不生效；点应用自己的最大化按钮（与负责人验收时相同的最大化窗口）。
  await until("最大化按钮", () => session.exec("const b = document.querySelector('.k-win-btn[aria-label=\"最大化\"]'); if (!b) return false; b.click(); return true;"));
  await until("窗口已最大化", () => session.exec("return Boolean(document.querySelector('.k-win-btn[aria-label=\"还原\"]'));"));
  const b = await session.invoke("create_library", { parent: libraries, name: "另一库" });
  await session.invoke("start_import", { libraryId: b.id, source: { paths: [small] } });
  await until("库 B 导入", async () => (await session.invoke("sidebar", { libraryId: b.id })).all === 4);
  const a = await session.invoke("create_library", { parent: libraries, name: "帧时间基线" });
  result.libraries = { a: a.id, b: b.id };
  await until("侧栏出现两个资料库", () => session.exec("return document.querySelectorAll('nav[aria-label=\"查找范围\"] [data-library-id]').length === 2;"));
  // 选中 A 的“全部图片”，展开它的目录：观察的就是负责人截图里的那一行。
  await session.exec("document.querySelector(`[data-library-id=\"${arguments[0]}\"] .lib-head-name`).click();", [a.id]);

  // #121：每帧记录 A、B 两行标题按钮是否还是同一个节点、是否变成不可用、张数文字。
  await session.exec(`
    const rows = window.__rowWatch = { frames: 0, replaced: {}, disabledFrames: {}, countBlankFrames: {}, labels: {}, stop: false };
    const nodes = {};
    const tick = () => {
      if (rows.stop) return;
      rows.frames++;
      for (const group of document.querySelectorAll('nav[aria-label="查找范围"] [data-library-id]')) {
        const id = group.dataset.libraryId;
        const head = group.querySelector('.lib-head-name');
        if (nodes[id] && nodes[id] !== head) rows.replaced[id] = (rows.replaced[id] ?? 0) + 1;
        nodes[id] = head;
        if (head?.disabled) rows.disabledFrames[id] = (rows.disabledFrames[id] ?? 0) + 1;
        const count = head?.querySelector('.sidebar-count')?.textContent ?? '';
        if (!/^\\d+$/.test(count)) rows.countBlankFrames[id] = (rows.countBlankFrames[id] ?? 0) + 1;
        rows.labels[id] = head?.getAttribute('aria-label');
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);`);

  const importStart = Date.now();
  await session.invoke("start_import", { libraryId: a.id, source: { paths: [samples] } });
  await until("导入开始", () => session.exec("return Boolean(document.querySelector('[aria-label=\"导入进度\"]'));"));
  // 导入中：切换浏览范围（全部图片 ↔ A），在另一库新建文件夹；各截一张应用窗口图。
  await delay(3000);
  await session.screenshot(join(work, "importing-1.png"));
  await session.exec("document.querySelector('nav[aria-label=\"查找范围\"] .side-top button').click();");
  await delay(1500);
  await session.exec("document.querySelector(`[data-library-id=\"${arguments[0]}\"] .lib-head-name`).click();", [a.id]);
  await delay(1500);
  await session.invoke("create_folder", { libraryId: b.id, name: "导入中新建", parent: null });
  await delay(1500);
  await session.screenshot(join(work, "importing-2.png"));
  await until("导入完成", () => session.exec("return !document.querySelector('[aria-label=\"导入进度\"]');"), 3_600_000, 500);
  const imported = (await session.invoke("sidebar", { libraryId: a.id })).all;
  // 读取或解码失败的项也会让进度条消失：张数必须与样本里不同内容的张数完全一致，否则不算这次测量。
  if (imported !== expected) throw new Error(`导入结果不完整：进库 ${imported} 张，样本里有 ${expected} 张不同内容的图`);
  result.import = { ms: Date.now() - importStart, all: imported, expected };
  result.import.imagesPerSec = Math.round((result.import.all / (result.import.ms / 1000)) * 10) / 10;
  result.sidebar = await session.exec("window.__rowWatch.stop = true; const { stop, ...rows } = window.__rowWatch; return rows;");
  console.log("导入", JSON.stringify(result.import), "侧栏", JSON.stringify(result.sidebar));
  save();

  // #123：浏览 A 的全部图片；每轮先量缩略图替换时间，再量帧时间（顺序的理由见文件开头）。
  await session.exec("document.querySelector(`[data-library-id=\"${arguments[0]}\"] .lib-head-name`).click();", [a.id]);
  await until("图片墙满 5000", () => session.exec("return Number(document.querySelector('.wall')?.dataset.total) >= arguments[0];", [result.import.all]), 60000);
  await until("探针", () => session.exec("return Boolean(window.__kinshokoPerf);"));
  await delay(2000);
  result.rounds = [];
  for (let round = 1; round <= rounds; round++) {
    const only = ["wheel-steady", "wheel-burst"];
    const replacement = await session.run("return await window.__kinshokoPerf.run({ only: arguments[0], sampleThumbnails: false, observeReplacement: true });", [only]);
    const frames = await session.run("return await window.__kinshokoPerf.run({ only: arguments[0], sampleThumbnails: false });", [only]);
    const pick = (report, field) => Object.fromEntries(report.scenarios.map((s) => [s.name, field(s)]));
    const entry = {
      round,
      environment: frames.environment,
      warnings: frames.warnings,
      frames: pick(frames, (s) => ({ p95: s.frames.p95, p99: s.frames.p99, dropRate60: s.frames.dropRate60, pass: s.frames.pass })),
      replacement: pick(replacement, (s) => s.replacement),
    };
    result.rounds.push(entry);
    console.log(`第 ${round} 轮`, JSON.stringify({ frames: entry.frames, replacement: entry.replacement }));
    save();
  }
  await session.screenshot(join(work, "wall.png"));
  result.status = "done";
} catch (error) {
  result.status = "failed";
  result.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
  if (session) await session.screenshot(join(work, "failure.png")).catch(() => {});
} finally {
  result.completedAt = new Date().toISOString();
  save();
  if (session) await wd("DELETE", session.base).catch(() => {});
  // 只结束本次 tauri-driver 进程树里的应用实例，不碰本机另开的同一构建。
  const cleanup = [
    "$all = @(Get-CimInstance Win32_Process); $tree = @{}",
    "$queue = [System.Collections.Generic.Queue[int]]::new(); $queue.Enqueue([int]$env:KINSHOKO_PERF_DRIVER_PID)",
    "while ($queue.Count) { $id = $queue.Dequeue(); if ($tree.ContainsKey($id)) { continue }; $tree[$id] = $true; foreach ($p in $all) { if ($p.ParentProcessId -eq $id) { $queue.Enqueue([int]$p.ProcessId) } } }",
    "$all | Where-Object { $tree.ContainsKey([int]$_.ProcessId) -and $_.ExecutablePath -eq $env:KINSHOKO_PERF_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  if (driver.pid) spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cleanup], { env: { ...process.env, KINSHOKO_PERF_EXE: application, KINSHOKO_PERF_DRIVER_PID: String(driver.pid) }, windowsHide: true });
  driver.kill();
  console.log(`结果：${join(work, "result.json")}`);
}
