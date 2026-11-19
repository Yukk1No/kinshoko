// 第十轮（左栏的行）的截图：现状（PR #635）与五套方案 ra–re，日间、夜间各一张 200% 的左栏，一张 1280 × 800 的整窗，
// 再把六张左栏并排拼成对照图（日间一张、夜间一张）。姿势一：选中第三层的“长发”，指针停在“背景”上（悬停滑块）；
// 姿势二：选中“全部图片”，指针移开（停在图库行上会弹出路径提示）。ROWS_PART=all 时只拍姿势二与对照图。
// 用本机的 Edge 无界面运行，经调试端口操作；不装任何依赖。
// 先开着原型的开发服务器，再运行：node design/prototype/main-window-material/row-shots.mjs [输出目录]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "shots"));
const variants = [
  ["now", "现状（#635）", "凸起纸片 · 名字墨色 · 图标与张数强调色"],
  ["ra", "甲 指示条", "平的淡墨底 · 左边一根强调色短条"],
  ["rb", "乙 压槽", "压进纸里，与查找框同一种槽"],
  ["rc", "丙 墨块", "实心墨色块，字翻成纸色"],
  ["rd", "丁 荧光笔", "没有底，名字上涂一道荧光笔"],
  ["re", "戊 暖纸", "深一档的纸色，不用强调色"],
];
const page = "http://127.0.0.1:1431/design/prototype/main-window-material/";
const edge = [process.env.EDGE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
if (!edge) throw new Error("找不到 msedge.exe；用环境变量 EDGE 指给它");
mkdirSync(out, { recursive: true });

const port = 9335;
const profile = mkdtempSync(join(tmpdir(), "kinshoko-rows-"));
const browser = spawn(edge, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--force-color-profile=srgb", "--no-first-run",
  "--disable-extensions", "--disable-sync", "--no-default-browser-check", "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const found = pages.find((entry) => entry.type === "page");
      if (found) return found.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await delay(200);
  }
  throw new Error("Edge 的调试端口没有起来");
}

const socket = new WebSocket(await target());
await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
let serial = 0;
const waiting = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const entry = waiting.get(message.id);
  if (!entry) return;
  waiting.delete(message.id);
  if (message.error) entry.fail(new Error(message.error.message)); else entry.done(message.result);
};
const send = (method, params = {}) => new Promise((done, fail) => { const id = ++serial; waiting.set(id, { done, fail }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};
const until = async (what, expression, timeout = 20000) => {
  for (const start = Date.now(); Date.now() - start < timeout; await delay(100)) if (await evaluate(expression)) return;
  throw new Error(`等不到：${what}`);
};
const rect = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)})).click()`);
const moveTo = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const rowAt = (text) => evaluate(`(() => { const r = [...document.querySelectorAll('.side-scroll .k-row')].find((el) => el.textContent.includes(${JSON.stringify(text)})).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

async function open(variant, theme, width, height, scale) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Page.bringToFront");
  await moveTo(width - 400, height - 200);
  for (let attempt = 1; ; attempt++) {
    await send("Page.navigate", { url: `${page}?variant=${variant}&theme=${theme}&bar=0&deep=1` });
    try { await until("图片墙", "document.querySelectorAll('.card img').length > 0", 12000); break; } catch (error) { if (attempt === 3) throw error; }
  }
  const folders = "[...document.querySelectorAll('.side-scroll .k-row')].some((el) => el.textContent.includes('长发'))";
  for (let attempt = 1; !(await evaluate(folders)); attempt++) {
    await clickText(".lib-head-name", "工作参考");
    try { await until("文件夹", folders, 3000); } catch (error) { if (attempt === 4) throw error; }
  }
  const chosen = "document.querySelector('.side-scroll .k-row[aria-current=\"page\"]')?.textContent.includes('长发')";
  for (let attempt = 1; !(await evaluate(chosen)); attempt++) {
    await clickText(".side-scroll .k-row", "长发");
    try { await until("选中", chosen, 3000); } catch (error) { if (attempt === 4) throw error; }
  }
  await until("缩略图", "[...document.querySelectorAll('.card img')].every((img) => img.complete && img.naturalWidth > 0)");
  await evaluate("document.fonts.ready.then(() => true)");
  // 子文件夹展开时各行逐行落下：等它放完再量行的位置。
  await delay(1200);
  const row = await rowAt("背景");
  // 悬停滑块跟着指针滑过去：分几步走过去，停够它放完。
  for (let step = 0; step <= 6; step++) await moveTo(row.x + row.width / 2 - 12 + step * 2, row.y + row.height / 2 - 6 + step);
  await delay(1400);
  if (await evaluate("document.visibilityState") !== "visible") throw new Error("页面是隐藏的：动画不会走，图不可信");
}

/** 第二个姿势：选中“全部图片”（各图库随之折起），指针不在左栏里。 */
async function openAll(variant, theme) {
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await send("Page.bringToFront");
  await moveTo(880, 600);
  for (let attempt = 1; ; attempt++) {
    await send("Page.navigate", { url: `${page}?variant=${variant}&theme=${theme}&bar=0&deep=1` });
    try { await until("图片墙", "document.querySelectorAll('.card img').length > 0", 12000); break; } catch (error) { if (attempt === 3) throw error; }
  }
  const chosen = "document.querySelector('.side-top .k-row[aria-current=\"page\"]') !== null";
  for (let attempt = 1; !(await evaluate(chosen)); attempt++) {
    await clickText(".side-top .k-row", "全部图片");
    try { await until("选中全部图片", chosen, 3000); } catch (error) { if (attempt === 4) throw error; }
  }
  await until("缩略图", "[...document.querySelectorAll('.card img')].every((img) => img.complete && img.naturalWidth > 0)");
  await evaluate("document.fonts.ready.then(() => true)");
  // 指针移开：停在图库行上会弹出路径的悬停提示，挡住要看的那一行。
  await moveTo(880, 600);
  await delay(1200);
}

async function shot(name, clip, quality = clip ? 100 : 90) {
  const { data } = await send("Page.captureScreenshot", { format: "webp", quality, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(out, `${name}.webp`), Buffer.from(data, "base64"));
  console.log("shot", name);
}

const SIDE_H = 600;
const ALL_H = 250;
try {
  await send("Page.enable");
  await send("Runtime.enable");
  for (const [variant] of variants) {
    for (const theme of ["light", "dark"]) {
      const tone = theme === "light" ? "day" : "night";
      await open(variant, theme, 1280, 800, 2);
      const side = await rect(".sidebar-slot");
      await shot(`rows-${variant}-side-${tone}`, { x: side.x - 8, y: 0, width: side.width + 16, height: SIDE_H });
      await openAll(variant, theme);
      const top = await rect(".sidebar-slot");
      await shot(`rows-${variant}-all-${tone}`, { x: top.x - 8, y: 0, width: top.width + 16, height: ALL_H });
      if (process.env.ROWS_PART === "all") continue;
      await open(variant, theme, 1280, 800, 1);
      await shot(`rows-${variant}-1280x800-${tone}`);
    }
  }
  // 对照图：六张左栏并排，上面写方案名与一句话。
  for (const [pose, height] of [["side", SIDE_H], ["all", ALL_H]]) for (const tone of ["day", "night"]) {
    const dark = tone === "night";
    const cells = variants.map(([variant, name, line]) => `<figure><figcaption><b>${name}</b><span>${line}</span></figcaption>
      <img src="${pathToFileURL(join(out, `rows-${variant}-${pose}-${tone}.webp`)).href}"></figure>`).join("");
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 24px; display: flex; gap: 20px; background: ${dark ? "#0f0e15" : "#e4dccb"}; font: 13px/1.4 "Microsoft YaHei UI", sans-serif; color: ${dark ? "#f4ecdc" : "#2b2747"}; }
      figure { margin: 0; display: flex; flex-direction: column; gap: 10px; }
      figcaption { display: flex; flex-direction: column; gap: 2px; height: 40px; }
      figcaption b { font-size: 15px; } figcaption span { opacity: 0.72; font-size: 12px; }
      img { width: ${264}px; height: ${height}px; border-radius: 6px; display: block; }
    </style>${cells}`;
    const file = join(out, `rows-compare-${pose}-${tone}.html`);
    writeFileSync(file, html);
    const width = 24 * 2 + variants.length * 264 + (variants.length - 1) * 20;
    await send("Emulation.setDeviceMetricsOverride", { width, height: height + 24 * 2 + 50, deviceScaleFactor: 2, mobile: false });
    await send("Page.navigate", { url: pathToFileURL(file).href });
    await until("对照图", "[...document.images].every((img) => img.complete && img.naturalWidth > 0)");
    await shot(pose === "side" ? `rows-compare-${tone}` : `rows-compare-all-${tone}`, null, 95);
    rmSync(file);
  }
} finally {
  socket.close();
  browser.kill();
  await delay(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
