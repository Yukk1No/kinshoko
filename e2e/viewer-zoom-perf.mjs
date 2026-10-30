// #128 查看器缩放响应测量：在真实 WebView2 里对不同尺寸的合成原图连续滚轮缩放，记录
// 输入到首次可见响应、连续缩放期间的帧间隔与图片是否跟上、停手到最终清晰图就绪的耗时。
// 用法：node e2e/viewer-zoom-perf.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]
// exe 要用独立 identifier 构建（tauri build --no-bundle --config '{"identifier":"…"}'），否则单实例插件会把
// 启动交给本机已在运行的 Kinshoko。
// 环境变量：KINSHOKO_ZOOM_PERF_OUTPUT（报告目录，默认 work/viewer-zoom-perf）、
// KINSHOKO_ZOOM_PERF_SIZES（逗号分隔的原图宽度，默认 1000,4000,8000）、KINSHOKO_ZOOM_PERF_SCENARIOS
// （逗号分隔：zoom-in、zoom-out、sweep）、KINSHOKO_ZOOM_PERF_LABEL、KINSHOKO_ZOOM_PERF_SNAPSHOT（in／out）。
// 每次运行用新的临时数据目录。“cold”是每个场景在这张图上的第一轮：只有每张图的第一个场景真正冷，
// 之后的场景可能用上前面读过的原图与派生图；要冷的扫动只跑 sweep。“warm”紧接着用同一手势再跑一轮。
// 滚轮事件由页面脚本派发，不经系统输入管线：首次响应不含输入送达的延迟。
// 任一手势帧间隔超出 #102 合格线（p95 ≤ 16.7 ms、p99 ≤ 25 ms）或有画面空白的帧时，退出码为 1。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { copyStandaloneRuntime } from "./native-standalone-guard.mjs";

const [, , appArg, edgeArg, driverArg = "tauri-driver"] = process.argv;
if (!appArg || !edgeArg) throw new Error("用法：node e2e/viewer-zoom-perf.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const SIZES = (process.env.KINSHOKO_ZOOM_PERF_SIZES ?? "1000,4000,8000").split(",").map(Number);
const work = mkdtempSync(join(tmpdir(), "kinshoko-zoomperf-"));
const application = copyStandaloneRuntime(appArg, work, "kinshoko-zoomperf.exe");
const parent = join(work, "libraries");
const source = join(work, "zoom");
const output = resolve(process.env.KINSHOKO_ZOOM_PERF_OUTPUT ?? "work/viewer-zoom-perf");
for (const dir of [parent, source, output, join(work, "roaming"), join(work, "local")]) mkdirSync(dir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, c) => {
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  let c = 0xffffffff;
  for (const b of body) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}
/** 3:2 合成原图：渐变底、细网格和随坐标变化的纹理，缩小时有可见细节，又不至于压不动。 */
function png(w, h) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  const stride = w * 3 + 1;
  const pixels = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const at = row + 1 + x * 3;
      const grid = x % 64 === 0 || y % 64 === 0;
      const tex = ((x * 7) ^ (y * 13)) & 31;
      pixels[at] = grid ? 30 : (x * 255 / w + tex) & 255;
      pixels[at + 1] = grid ? 30 : (y * 255 / h + tex) & 255;
      pixels[at + 2] = grid ? 30 : 120 + tex;
    }
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
const names = SIZES.map((w) => `zoom-${w}.png`);
for (const [i, w] of SIZES.entries()) writeFileSync(join(source, names[i]), png(w, Math.round(w * 2 / 3)));

const PORT = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4457);
const DRIVER = `http://127.0.0.1:${PORT}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
async function wd(method, path, body) {
  const response = await fetch(DRIVER + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return path === "/session" && result.sessionId ? { sessionId: result.sessionId, capabilities: result.value } : result.value;
}
async function until(what, read, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${what}${last ? ` (${last.message})` : ""}`);
}
const driver = spawn(driverArg, ["--port", String(PORT), "--native-port", String(PORT + 1), "--native-driver", resolve(edgeArg)], {
  windowsHide: true,
  env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const stopped = new Promise((resolve) => driver.once("exit", resolve));
let base;
const exec = (script, args = []) => wd("POST", `${base}/execute/sync`, { script, args });
const execAsync = (script, args = []) => wd("POST", `${base}/execute/async`, { script, args });
const find = async (xpath) => {
  const element = await wd("POST", `${base}/element`, { using: "xpath", value: xpath });
  return element[ELEMENT] ?? element.ELEMENT;
};
const click = async (text) => wd("POST", `${base}/element/${await find(`//button[normalize-space()='${text}' or @aria-label='${text}' or starts-with(@aria-label,'${text}，')]`)}/click`, {});
const key = async (value) => wd("POST", `${base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }] });

/**
 * 页面内的测量：按固定墙钟节奏在舞台中心派发滚轮事件（主线程卡住时事件也会被推迟，与真实输入一致），
 * 每个 rAF 记录一帧：图片是否可见、显示尺寸是否已等于当前缩放、来源是否为最终精确来源。
 * 停手后等到“最终清晰图”：可见、来源与当前缩放精确匹配、并且 img.decode() 完成。
 */
/** 页面内共用：.viewer-image 是正在请求的精确来源，.viewer-stand-in 是临时顶上的替身（#128）。 */
const PAGE = String.raw`
const stage = document.querySelector('.viewer-stage');
const main = () => stage.querySelector('img.viewer-image');
const drawn = (i) => getComputedStyle(i).visibility === 'visible' && i.complete && i.naturalWidth > 0;
/** 来源与当前缩放精确匹配：100% 以上是原图（full），以下是同宽的 fit-N。 */
const exactFor = (i) => {
  const physical = Math.round(parseFloat(i.style.width) * devicePixelRatio);
  const m = /\/(full|fit-(\d+))(?:\?|$)/.exec(i.src);
  return !!m && (m[1] === 'full' ? i.naturalWidth <= physical : Number(m[2]) === physical);
};
`;
const MEASURE = PAGE + String.raw`
const [steps, deltaY, intervalMs, settleMs, swing, done] = arguments;
const dpr = devicePixelRatio;
/** 任一张画出来都算可见：精确来源或替身。 */
const state = () => {
  const i = main();
  if (!i) return { visible: false };
  const target = parseFloat(i.style.width);
  const shown = [i, ...stage.querySelectorAll('img.viewer-stand-in')].find(drawn);
  if (!shown) return { visible: false, target, exact: false };
  return { visible: true, target, rendered: shown.getBoundingClientRect().width, exact: shown === i && exactFor(i) };
};
const startState = state();
const frames = [];
const loaf = [];
let observer = null;
try {
  observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration ?? null, scripts: (e.scripts ?? []).slice(0, 3).map((s) => ({ src: (s.sourceURL ?? '').split('/').pop() + '#' + (s.sourceFunctionName ?? ''), invoker: s.invoker, duration: s.duration })) }); });
  observer.observe({ type: 'long-animation-frame', buffered: false });
} catch {}
let inputs = [];
let finished = false;
let lastInput = null;
let settled = null;
let settledState = null;
const tick = (t) => {
  const s = state();
  frames.push({ t, ...s });
  if (lastInput !== null && !settled && s.visible && s.exact && Math.abs(s.rendered - s.target) < 0.5) {
    const i = main();
    settled = 'pending';
    i.decode().then(() => requestAnimationFrame((t2) => { const now = state(); if (now.visible && now.exact) { settled = t2; settledState = now; } else settled = null; }), () => { settled = null; });
  }
  if (!finished) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
const origin = performance.now() + 50;
const rect = stage.getBoundingClientRect();
for (let k = 0; k < steps; k++) {
  const due = origin + k * intervalMs;
  await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
  const at = performance.now();
  stage.dispatchEvent(new WheelEvent('wheel', { deltaY: swing && Math.floor(k / swing) % 2 ? -deltaY : deltaY, deltaMode: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
  inputs.push({ due, at });
}
lastInput = inputs.at(-1).at;
const deadline = performance.now() + settleMs;
while (typeof settled !== 'number' && performance.now() < deadline) await new Promise((r) => setTimeout(r, 10));
finished = true;
observer?.disconnect();
const firstInput = inputs[0].at;
const gesture = frames.filter((f) => f.t >= firstInput && f.t <= lastInput + 1);
const intervals = gesture.slice(1).map((f, k) => f.t - gesture[k].t);
const firstVisible = frames.find((f) => f.t >= firstInput && f.visible && Math.abs(f.rendered - startState.rendered) > 0.5);
done({
  dpr, viewport: { width: stage.clientWidth, height: stage.clientHeight },
  start: startState, end: settledState ?? state(),
  inputs: inputs.length, inputLagMs: Math.max(...inputs.map((i) => i.at - i.due)),
  gestureMs: lastInput - firstInput,
  firstResponseMs: firstVisible ? firstVisible.t - firstInput : null,
  intervals,
  gestureFrames: gesture.length,
  hiddenFrames: gesture.filter((f) => !f.visible).length,
  trackingFrames: gesture.filter((f) => f.visible && Math.abs(f.rendered - f.target) < 0.5).length,
  settleMs: typeof settled === 'number' ? settled - lastInput : null,
  longFrames: loaf.filter((e) => e.start >= firstInput - 5).map((e) => ({ ...e, start: e.start - firstInput })),
  // thumb 协议请求：派生图在 Rust 端生成的耗时大致等于请求时长。
  requests: performance.getEntriesByType('resource').filter((e) => e.startTime >= firstInput - 5 && /thumb\.localhost/.test(e.name))
    .map((e) => ({ src: e.name.split('/').pop(), start: Math.round(e.startTime - firstInput), ms: Math.round(e.duration) })),
});
performance.clearResourceTimings();
`;
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
};
const round = (v) => v === null ? null : Math.round(v * 10) / 10;
const sharp = () => exec(PAGE + "const i = main(); return !!i && drawn(i) && exactFor(i) && !document.querySelector('.viewer-message');");

const SCENARIOS = [
  { name: "zoom-in", from: "适应窗口", steps: 24, deltaY: -50 },
  { name: "zoom-out", from: "原始像素", steps: 24, deltaY: 50 },
  // 约 3 秒不停手地来回缩放、反复跨过 100%：约 500 帧，p99 才不等于最长一帧。
  { name: "sweep", from: "适应窗口", steps: 180, deltaY: -50, swing: 30 },
].filter((s) => !process.env.KINSHOKO_ZOOM_PERF_SCENARIOS || process.env.KINSHOKO_ZOOM_PERF_SCENARIOS.split(",").includes(s.name));
const INTERVAL = 16;
const results = [];
try {
  await until("WebDriver 就绪", () => fetch(`${DRIVER}/status`).then((r) => r.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
  base = `/session/${session.sessionId}`;
  await wd("POST", `${base}/window/rect`, { x: 40, y: 40, width: 1600, height: 1000 });
  await wd("POST", `${base}/element/${await until("欢迎页", () => find("//button[@aria-labelledby='welcome-create']"))}/click`, {}); // #172：欢迎页先选“新建图库”
  const name = await until("建库引导", () => find("//label[contains(., '图库名称')]/input"));
  await wd("POST", `${base}/element/${name}/clear`, {});
  await wd("POST", `${base}/element/${name}/value`, { text: "缩放测量" });
  await exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]", [parent]);
  await click("选择存放位置…");
  await click("建立图库");
  await until("打开图库", () => find("//nav[@aria-label='查找范围']//*[@data-library-id]//button[contains(@class,'lib-head-name') and starts-with(@aria-label,'缩放测量（') and not(@disabled)]"));
  await exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]", [source]);
  await click("导入");
  await wd("POST", `${base}/element/${await until("文件夹菜单项", () => find("//*[@role='menuitem' and normalize-space()='文件夹']"))}/click`, {});
  const librarySelect = "[...document.querySelectorAll('.k-import-dialog select')].find(s=>s.labels?.[0]?.querySelector('.k-field-label')?.textContent.trim()==='放到图库')";
  await until("导入对话框", () => exec(`return !!${librarySelect}?.options[1]`));
  await exec(`const s=${librarySelect};s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));`);
  await until("开始导入可用", () => exec("return [...document.querySelectorAll('.k-import-dialog button')].some(b=>b.textContent.trim()==='开始导入'&&!b.disabled)"));
  await click("开始导入");
  await until("导入完成", () => exec(`return [...document.querySelectorAll('.k-toast')].some(t=>t.querySelector('.k-toast-title')?.textContent==='导入完成'&&t.querySelector('.k-toast-stats')?.textContent.includes('新增 ${SIZES.length}'));`), 300000);
  // 导入结束是一条轻提示（#388），没有回执卡可关；收起提示，免得盖住右下角。
  await exec("document.querySelectorAll('.k-toast .k-toast-close').forEach(b=>b.click())");
  await until("提示已收起", () => exec("return !document.querySelector('.k-toast')"));
  const card = await until("卡片", () => find("//*[contains(@class,'card') and @data-id]"));
  await wd("POST", `${base}/element/${card}/click`, {});
  await key("");
  await until("查看器", sharp, 120000);
  for (const [i, width] of SIZES.entries()) {
    // 先退到第一张，再逐张往后找；标题随图片详情异步出现。
    await until(`回到第一张`, () => exec("const b = document.querySelector('[aria-label=上一张]'); if (b && !b.disabled) { b.click(); return false; } return true;"));
    let leaving = null;
    await until(`打开 ${names[i]}`, async () => {
      const title = await exec("return document.querySelector('.viewer-title')?.textContent");
      if (title === names[i]) return true;
      if (title && title !== leaving) { leaving = title; await exec("document.querySelector('[aria-label=下一张]')?.click()"); }
      return false;
    }, 60000);
    for (const scenario of SCENARIOS) {
      for (const cache of ["cold", "warm"]) {
        await click(scenario.from);
        await until(`${names[i]} 起点清晰`, sharp, 120000);
        await new Promise((r) => setTimeout(r, 300));
        const raw = await execAsync(MEASURE, [scenario.steps, scenario.deltaY, INTERVAL, 60000, scenario.swing ?? 0]);
        const { intervals, longFrames, ...rest } = raw;
        const row = {
          width, scenario: scenario.name, cache, ...rest,
          p50: round(pct(intervals, 50)), p95: round(pct(intervals, 95)), p99: round(pct(intervals, 99)), max: round(pct(intervals, 100)),
          gate: pct(intervals, 95) <= 16.7 && pct(intervals, 99) <= 25,
          longFrames: longFrames.slice(0, 10),
        };
        results.push(row);
        console.log(`${String(width).padStart(5)} ${scenario.name.padEnd(8)} ${cache.padEnd(4)} first=${round(row.firstResponseMs)}ms p95=${row.p95} p99=${row.p99} max=${row.max} hidden=${row.hiddenFrames}/${row.gestureFrames} tracking=${row.trackingFrames}/${row.gestureFrames} settle=${round(row.settleMs)}ms loaf=${longFrames.length} req=${row.requests.map((q) => q.src + ":" + q.ms).join(",")}`);
      }
    }
  }
  const label = process.env.KINSHOKO_ZOOM_PERF_LABEL ?? "run";
  // 手势进行中的窗口截图（最后一张、也是最大的图）：KINSHOKO_ZOOM_PERF_SNAPSHOT=in 从适应窗口放大，
  // =out 从原始像素缩小；页面里排好 40 格滚轮，约 250 ms 后截图。
  const snapshot = process.env.KINSHOKO_ZOOM_PERF_SNAPSHOT;
  if (snapshot === "in" || snapshot === "out") {
    await click(snapshot === "in" ? "适应窗口" : "原始像素");
    await until("截图起点清晰", sharp, 120000);
    await exec(`const stage = document.querySelector('.viewer-stage'); const r = stage.getBoundingClientRect();
      for (let k = 0; k < 40; k++) setTimeout(() => stage.dispatchEvent(new WheelEvent('wheel', { deltaY: ${snapshot === "in" ? -50 : 50}, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })), k * 16);`);
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(join(output, `${label}-mid-zoom-${snapshot}.png`), Buffer.from(await wd("GET", `${base}/screenshot`), "base64"));
  }
  writeFileSync(join(output, `${label}.json`), JSON.stringify({ label, intervalMs: INTERVAL, scenarios: SCENARIOS, userAgent: await exec("return navigator.userAgent"), results }, null, 2));
  const failed = results.filter((r) => !r.gate || r.hiddenFrames > 0);
  for (const r of failed) console.error(`未达标：${r.width} ${r.scenario} ${r.cache} p95=${r.p95} p99=${r.p99} hidden=${r.hiddenFrames}/${r.gestureFrames}`);
  if (failed.length) process.exitCode = 1;
  const screenshot = await wd("GET", `${base}/screenshot`);
  writeFileSync(join(output, `${label}.png`), Buffer.from(screenshot, "base64"));
} catch (error) {
  if (base) {
    const screenshot = await wd("GET", `${base}/screenshot`).catch(() => null);
    if (screenshot) writeFileSync(join(output, "failure.png"), Buffer.from(screenshot, "base64"));
  }
  throw error;
} finally {
  if (base) await wd("DELETE", base).catch(() => {});
  driver.kill();
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  const target = resolve(work);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("kinshoko-zoomperf-")) throw new Error("拒绝清理非测试临时目录");
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
