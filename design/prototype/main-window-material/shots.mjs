// 质感原型（#606）的截图：每套方案 1280 × 800 与 1920 × 1080、日间与夜间各一张，另有详情栏打开的一张、200% 的查找框加左栏、200% 的材质样本。
// 第六轮另有查找框选中、拖动文件夹的 200% 图，和一段会动的录像（录像要本机有 ffmpeg，没有就跳过）。
// 用本机的 Edge（与 WebView2 同一个内核）无界面运行，经调试端口操作；不装任何依赖。
// 先开着原型的开发服务器，再运行：node design/prototype/main-window-material/shots.mjs [输出目录] [方案…]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , outArg, ...only] = process.argv;
const out = resolve(outArg ?? join(here, "shots"));
const variants = only.length ? only : ["now", "a", "b", "c", "c2", "c3", "c4", "c5", "c4a", "c4b", "c4c", "c4d", "c4e"];
const page = "http://127.0.0.1:1431/design/prototype/main-window-material/";
const edge = [process.env.EDGE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
if (!edge) throw new Error("找不到 msedge.exe；用环境变量 EDGE 指给它");
mkdirSync(out, { recursive: true });

const port = 9334;
const profile = mkdtempSync(join(tmpdir(), "kinshoko-proto-"));
const browser = spawn(edge, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--force-color-profile=srgb", "--no-first-run",
  // 新的配置目录会自己登录、同步并装上扩展，十几秒后扩展的欢迎页开在新标签页里，原型这一页就成了后台页：
  // 动画时钟停住、requestAnimationFrame 不来，展开到一半的目录点不中。所以不要扩展、不要同步。
  "--disable-extensions", "--disable-sync", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
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
let onFrame = null;
const waiting = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (process.env.SHOTS_DEBUG && message.method && /exceptionThrown|entryAdded|loadingFailed/.test(message.method)) console.log(message.method, JSON.stringify(message.params).slice(0, 600));
  if (message.method === "Page.screencastFrame") onFrame?.(message.params);
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
const rowAt = (text) => evaluate(`(() => { const r = [...document.querySelectorAll('.side-scroll .k-row')].find((el) => el.textContent.includes(${JSON.stringify(text)})).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
/** 按住一行拖到 (x, y)，不松手。没拖起来就松手重来。 */
async function dragTo(text, x, y) {
  for (let attempt = 1; ; attempt++) {
    const from = await rowAt(text);
    const start = { x: from.x + 70, y: from.y + from.height / 2 };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
    await delay(120);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 12; step++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + (x - start.x) * step / 12, y: start.y + (y - start.y) * step / 12, button: "left", buttons: 1 });
      await delay(30);
    }
    if (await evaluate("'dragging' in document.documentElement.dataset")) return;
    await release(x, y);
    await delay(400);
    if (attempt === 4) throw new Error(`拖不起来：${text}`);
  }
}
const release = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });

/** 打开一个方案并摆好姿势：选中“工作参考”里的“人物”文件夹，指针停在下一行“服装”上。详情栏默认收起。 */
async function open(variant, theme, width, height, scale, extra = "") {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Page.bringToFront");
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
  // 详情栏打开的那一张不摆这个姿势：留一张没有查找条件、面板收着的样子。
  const posed = !extra.includes("inspector") && !extra.includes("plain");
  if (posed && (variant === "c4a" || variant === "c4c")) {
    await evaluate("document.querySelector('.proto-groups-btn, .proto-groups-icon').click()");
    await until("分组面板", "document.querySelector('.proto-groups-pop') !== null");
    for (const name of ["蓝发", "红瞳"]) { await clickText(".proto-groups-pop .chip", name); await delay(300); }
  }
  if (posed && variant === "c4b") {
    for (const name of ["发色", "瞳色"]) await clickText(".proto-side-groups .k-row", name);
    for (const name of ["蓝发", "红瞳"]) { await clickText(".proto-tag-row", name); await delay(300); }
  }
  await moveTo(row.x - 6, row.y);
  await moveTo(row.x, row.y);
  await delay(700);
  if (await evaluate("document.visibilityState") !== "visible") throw new Error("页面是隐藏的：动画不会走，图不可信");
}
const press = (x, y) => send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
/** 指针从上一个位置走到 (x, y)，用 ms 毫秒；held 为按着左键。 */
let hand = { x: 0, y: 0 };
async function glide(x, y, ms, held = false) {
  const steps = Math.max(1, Math.round(ms / 16));
  const from = hand;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps, eased = t * t * (3 - 2 * t);
    hand = { x: from.x + (x - from.x) * eased, y: from.y + (y - from.y) * eased };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hand, ...(held ? { button: "left", buttons: 1 } : {}) });
    await delay(16);
  }
}
const middle = async (text) => { const r = await rowAt(text); return { x: r.x + 84, y: r.y + r.height / 2, top: r.y, height: r.height }; };

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
/** 录一段动作，裁出 clip，存成会动的 WebP。 */
async function record(name, clip, act) {
  if (!hasFfmpeg) { console.log("没有 ffmpeg，跳过录像", name); return; }
  const dir = mkdtempSync(join(tmpdir(), "kinshoko-rec-"));
  const frames = [];
  onFrame = ({ data, metadata, sessionId }) => {
    frames.push({ file: `f${frames.length}.jpg`, at: metadata.timestamp });
    writeFileSync(join(dir, frames.at(-1).file), Buffer.from(data, "base64"));
    void send("Page.screencastFrameAck", { sessionId });
  };
  await send("Page.startScreencast", { format: "jpeg", quality: 95, everyNthFrame: 1 });
  try { await act(); } finally { await send("Page.stopScreencast"); onFrame = null; }
  const list = frames.map((frame, index) => `file '${frame.file}'\nduration ${Math.max(0.016, (frames[index + 1]?.at ?? frame.at + 0.8) - frame.at).toFixed(3)}`).join("\n");
  writeFileSync(join(dir, "list.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
  const made = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", `crop=${clip.width}:${clip.height}:${clip.x}:${clip.y},fps=30`,
    "-c:v", "libwebp_anim", "-q:v", "72", "-loop", "0", join(out, `${name}.webp`)], { cwd: dir, encoding: "utf8" });
  if (made.status !== 0) throw new Error(`ffmpeg：${made.stderr.slice(-400)}`);
  rmSync(dir, { recursive: true, force: true });
  console.log("录像", name, frames.length, "帧");
}

/** 第六轮的一段演示：换选中的行，拖“背景”到“发型”“表情”之间、在“服装”上停一下、最后放到“制服”“和服”之间，收起再展开图库，点进查找框。 */
async function demo() {
  const light = await middle("光影");
  hand = { x: light.x + 60, y: light.y + 90 };
  await glide(light.x, light.y, 500);
  await press(light.x, light.y); await release(light.x, light.y);
  await delay(700);
  for (let attempt = 1; ; attempt++) {
    const from = await middle("背景");
    await glide(from.x, from.y, 350);
    await delay(150);
    await press(from.x, from.y);
    await glide(from.x + 6, from.y - 8, 120, true);
    if (await evaluate("'dragging' in document.documentElement.dataset")) break;
    await release(hand.x, hand.y);
    await delay(400);
    if (attempt === 4) throw new Error("录像里拖不起来");
  }
  const first = await rowAt("表情");
  await glide(first.x + 90, first.y + 2, 700, true);
  await delay(650);
  const onto = await rowAt("服装");
  await glide(onto.x + 96, onto.y + onto.height / 2, 600, true);
  await delay(900);
  const second = await rowAt("和服");
  await glide(second.x + 100, second.y - 6, 450, true);
  await delay(650);
  await release(hand.x, hand.y);
  await delay(1100);
  const toggle = await rect(".lib-group .workspace-expand");
  await glide(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2, 450);
  await press(hand.x, hand.y); await release(hand.x, hand.y);
  await delay(800);
  await press(hand.x, hand.y); await release(hand.x, hand.y);
  await delay(1000);
  const search = await rect(".topbar > .search");
  await glide(search.x + 150, search.y + search.height / 2, 500);
  await press(hand.x, hand.y); await release(hand.x, hand.y);
  await delay(1200);
}

/** 一行文件夹图标的中心。 */
const iconAt = async (text) => { const r = await rowAt(text); return { x: r.x + 15.5, y: r.y + r.height / 2 }; };
/** 第八轮的一段演示：折起再展开“服装”，折起再展开“发型”，选中“长发”，折起再展开“人物”（折起时图标带强调色，因为选中的在里面）。 */
async function treeDemo() {
  hand = { x: 900, y: 600 };
  const click = async () => { await press(hand.x, hand.y); await release(hand.x, hand.y); };
  for (const name of ["服装", "发型"]) {
    const at = await iconAt(name);
    await glide(at.x, at.y, 550);
    await delay(550);
    await click(); await delay(750);
    await click(); await delay(850);
  }
  const pick = await middle("长发");
  await glide(pick.x, pick.y, 450);
  await click(); await delay(800);
  const top = await iconAt("人物");
  await glide(top.x, top.y, 500);
  await delay(550);
  await click(); await delay(1000);
  await click(); await delay(1000);
}

/** 整屏用有损 WebP（色块渐变的 PNG 每张近 1 MB）；放大图要看半像素线，用质量 100。 */
async function shot(name, clip, quality = clip ? 100 : 90) {
  const { data } = await send("Page.captureScreenshot", { format: "webp", quality, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
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
      // 第七轮，200%：选中并展开的文件夹（“人物”）和它下面的子文件夹，指针移开，不带悬停。SHOTS_PART=folder 时只出这一张。
      if (["c4d", "c4e"].includes(variant)) {
        await open(variant, theme, 1280, 800, 2, "&plain=1");
        await moveTo(1000, 700);
        await delay(400);
        const side = await rect(".sidebar-slot");
        await shot(`${variant}-folder-${tone}`, { x: side.x - 12, y: 136, width: side.width + 20, height: 252 });
      }
      // 第八轮，200%：子文件夹的层级。选中第三层的“长发”、折起“服装”；再把指针停在“人物”的图标上（图标先合上）。另录一段折起与展开。
      if (["c4f", "c4g"].includes(variant)) {
        await open(variant, theme, 1280, 800, 2, "&plain=1");
        const side = await rect(".sidebar-slot");
        const clip = { x: side.x - 12, y: 136, width: side.width + 20, height: 352 };
        await clickText(".side-scroll .k-row", "长发");
        const folding = await iconAt("服装");
        await moveTo(folding.x, folding.y); await press(folding.x, folding.y); await release(folding.x, folding.y);
        await moveTo(1000, 700);
        await delay(800);
        await shot(`${variant}-tree-${tone}`, clip);
        const hover = await iconAt("人物");
        await moveTo(hover.x - 2, hover.y); await moveTo(hover.x, hover.y);
        await delay(700);
        await shot(`${variant}-tree-hover-${tone}`, clip);
        await open(variant, theme, 1280, 800, 1, "&plain=1");
        await record(`${variant}-tree-motion-${tone}`, { x: 0, y: 100, width: 330, height: 420 }, treeDemo);
      }
      if (process.env.SHOTS_PART === "folder") continue;
      // SHOTS_PART=extra 时只出后面的放大图（调拖动的时候用）。
      if (process.env.SHOTS_PART !== "extra") {
        for (const [width, height] of [[1280, 800], [1920, 1080]]) {
          await open(variant, theme, width, height, 1);
          await shot(`${variant}-${width}x${height}-${tone}`);
        }
        // 详情栏打开、没有选图。
        await open(variant, theme, 1280, 800, 1, "&inspector=1");
        await shot(`${variant}-1280x800-inspector-${tone}`);
      }
      // 200%：左栏的上半段（选中的一行、悬停的一行）与查找框的左半。C2、C3、C5 的材质与 C、C4 相同，不重复出。
      // 第六轮，200%：查找框选中的样子（C4c 是粉色的环，C4d 是变实的槽口），顺带看文件夹视图。
      if (variant === "c4c" || variant === "c4d") {
        await open(variant, theme, 1280, 800, 2, "&plain=1");
        await moveTo(900, 600);
        await evaluate("document.querySelector('.search-field input').focus()");
        await delay(500);
        const side = await rect(".sidebar-slot");
        await shot(`${variant}-search-${tone}`, { x: side.x - 16, y: 0, width: 780, height: 336 });
      }
      // 第六轮，200%：拖动文件夹。“背景”拖到“发型”与“表情”之间（线两边的行让开），再拖到“服装”上停住（放进去）。
      if (variant === "c4d") {
        await open(variant, theme, 1280, 800, 2);
        const side = await rect(".sidebar-slot");
        const clip = { x: side.x - 16, y: 0, width: 780, height: 440 };
        const gap = await rowAt("表情");
        await dragTo("背景", gap.x + 76, gap.y + 3);
        await delay(700);
        if (process.env.SHOTS_DEBUG) console.log("拖动中：", await evaluate("JSON.stringify({ dragging: 'dragging' in document.documentElement.dataset, ghost: document.querySelectorAll('.proto-drag-ghost').length, line: document.querySelector('.proto-drag-line')?.outerHTML })"));
        await shot(`c4d-drag-${tone}`, clip, 92);
        const onto = await rowAt("服装");
        for (const dy of [2, 1, 0]) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: onto.x + 80, y: onto.y + onto.height / 2 - dy, button: "left", buttons: 1 }); await delay(40); }
        await delay(900);
        await shot(`c4d-drag-into-${tone}`, clip, 92);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: gap.x + 76, y: gap.y + 3, button: "left", buttons: 1 });
        await delay(400);
        await release(gap.x + 76, gap.y + 3);
        await delay(900);
        console.log("拖动之后的顺序：", await evaluate("[...document.querySelectorAll('.sidebar button[data-folder-id]')].map((b) => (b.style.paddingLeft === '8px' ? '' : '· ') + b.querySelector('.sidebar-label').textContent).join(' / ')"));
        // 录像：1280 × 800，裁出左栏与查找框的左半。
        await open(variant, theme, 1280, 800, 1);
        await record(`c4d-motion-${tone}`, { x: 0, y: 0, width: 760, height: 480 }, demo);
      }
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
