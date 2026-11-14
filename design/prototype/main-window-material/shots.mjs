// 质感原型（#606）的截图：每套方案 1280 × 800 与 1920 × 1080、日间与夜间各一张，另有详情栏打开的一张、200% 的查找框加左栏、200% 的材质样本。
// 用本机的 Edge（与 WebView2 同一个内核）无界面运行，经调试端口操作；不装任何依赖。
// 先开着原型的开发服务器，再运行：node design/prototype/main-window-material/shots.mjs [输出目录] [方案…]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , outArg, ...only] = process.argv;
const out = resolve(outArg ?? join(here, "shots"));
const variants = only.length ? only : ["now", "a", "b", "c", "c2", "c3", "c4", "c5", "c4a", "c4b"];
const page = "http://127.0.0.1:1431/design/prototype/main-window-material/";
const edge = [process.env.EDGE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
if (!edge) throw new Error("找不到 msedge.exe；用环境变量 EDGE 指给它");
mkdirSync(out, { recursive: true });

const port = 9334;
const profile = mkdtempSync(join(tmpdir(), "kinshoko-proto-"));
const browser = spawn(edge, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--force-color-profile=srgb", "--no-first-run", "about:blank"], { stdio: "ignore" });
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
  if (process.env.SHOTS_DEBUG && message.method && /exceptionThrown|entryAdded|loadingFailed/.test(message.method)) console.log(message.method, JSON.stringify(message.params).slice(0, 600));
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
  throw new Error(`等不到：${what}（${await evaluate("location.search + ' | ' + document.body.innerText.slice(0, 200).replace(/\s+/g, ' ')")}）`);
};
const rect = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)})).click()`);
const moveTo = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

/** 打开一个方案并摆好姿势：选中“工作参考”里的“人物”文件夹，指针停在下一行“服装”上。详情栏默认收起。 */
async function open(variant, theme, width, height, scale, extra = "") {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await moveTo(width - 400, height - 200);
  // 开发服务器偶尔回一张空白页（依赖重新打包的那一刻），重开一次就好。
  for (let attempt = 1; ; attempt++) {
    await send("Page.navigate", { url: `${page}?variant=${variant}&theme=${theme}&bar=0${extra}` });
    try { await until("图片墙", "document.querySelectorAll('.card img').length > 0", 12000); break; } catch (error) { if (attempt === 3) throw error; }
  }
  // 界面刚画出来时点击偶尔落空：没生效就再点。
  const folders = "[...document.querySelectorAll('.side-scroll .k-row')].some((el) => el.textContent.includes('人物'))";
  for (let attempt = 1; !(await evaluate(folders)); attempt++) {
    await clickText(".lib-head-name", "工作参考");
    try { await until("文件夹", folders, 3000); } catch (error) { if (attempt === 4) throw error; }
  }
  const chosen = "document.querySelector('.side-scroll .k-row[aria-current=\"page\"]') !== null";
  for (let attempt = 1; !(await evaluate(chosen)); attempt++) {
    await clickText(".side-scroll .k-row", "人物");
    try { await until("选中", chosen, 3000); } catch (error) { if (attempt === 4) throw error; }
  }
  await until("缩略图", "[...document.querySelectorAll('.card img')].every((img) => img.complete && img.naturalWidth > 0)");
  await evaluate("document.fonts.ready.then(() => true)");
  const row = await evaluate(`(() => { const r = [...document.querySelectorAll('.k-row')].find((el) => el.textContent.includes('服装')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  // 第四轮：分组的新摆法要看选了标签的样子。面板打开、选“蓝发”与“红瞳”；左栏展开“发色”与“瞳色”、同样选这两个。
  if (variant === "c4a") {
    await evaluate("document.querySelector('.proto-groups-btn').click()");
    await until("分组面板", "document.querySelector('.proto-groups-pop') !== null");
    for (const name of ["蓝发", "红瞳"]) { await clickText(".proto-groups-pop .chip", name); await delay(300); }
  }
  if (variant === "c4b") {
    for (const name of ["发色", "瞳色"]) await clickText(".proto-side-groups .k-row", name);
    for (const name of ["蓝发", "红瞳"]) { await clickText(".proto-tag-row", name); await delay(300); }
  }
  await moveTo(row.x - 6, row.y);
  await moveTo(row.x, row.y);
  await delay(700);
}
/** 整屏用有损 WebP（色块渐变的 PNG 每张近 1 MB）；放大图要看半像素线，用质量 100。 */
async function shot(name, clip) {
  const { data } = await send("Page.captureScreenshot", { format: "webp", quality: clip ? 100 : 90, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(out, `${name}.webp`), Buffer.from(data, "base64"));
  console.log("shot", name);
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  if (process.env.SHOTS_DEBUG) { await send("Log.enable"); await send("Network.enable"); }
  for (const variant of variants) {
    for (const theme of ["light", "dark"]) {
      const tone = theme === "light" ? "day" : "night";
      for (const [width, height] of [[1280, 800], [1920, 1080]]) {
        await open(variant, theme, width, height, 1);
        await shot(`${variant}-${width}x${height}-${tone}`);
      }
      // 详情栏打开、没有选图。
      await open(variant, theme, 1280, 800, 1, "&inspector=1");
      await shot(`${variant}-1280x800-inspector-${tone}`);
      // 200%：左栏的上半段（选中的一行、悬停的一行）与查找框的左半。C2、C3、C5 的材质与 C、C4 相同，不重复出。
      if (!["now", "a", "b", "c", "c4"].includes(variant)) continue;
      await open(variant, theme, 1280, 800, 2);
      const side = await rect(".sidebar-slot");
      await shot(`${variant}-zoom-${tone}`, { x: side.x - 16, y: 0, width: 780, height: 336 });
      // 200%：材质样本（输入框、下拉与已定材质的按钮、滑条、分段）。只有第一轮的方案各不相同。
      if (!["now", "a", "b", "c"].includes(variant)) continue;
      await open(variant, theme, 1280, 800, 2, "&specimen=1");
      const specimen = await rect(".proto-specimen");
      await shot(`${variant}-specimen-${tone}`, { x: specimen.x - 24, y: specimen.y - 24, width: specimen.width + 48, height: specimen.height + 48 });
    }
  }
} finally {
  socket.close();
  browser.kill();
  await delay(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
