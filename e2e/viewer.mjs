// #47 原生 WebView2 冒烟：真实双击、两条显示路径、DPI、字体、重排、返回焦点。
// 用法：node e2e/viewer.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]
// 本地并行测试宜以独立 identifier 构建；默认使用 4447 / 4448，不占用 #44 的端口。
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, driverArg = "tauri-driver"] = process.argv;
if (!appArg || !edgeArg) throw new Error("用法：node e2e/viewer.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const work = mkdtempSync(join(tmpdir(), "kinshoko-viewer47-"));
const application = join(work, "kinshoko-viewer47.exe");
copyFileSync(resolve(appArg), application);
const parent = join(work, "libraries");
const source = join(work, "参考");
const output = resolve(process.env.KINSHOKO_VIEWER_OUTPUT ?? "work/viewer47");
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
function png(w, h, colour) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rgb = typeof colour === "function" ? colour(x, y) : colour;
    const at = y * (w * 3 + 1) + 1 + x * 3;
    pixels[at] = rgb[0]; pixels[at + 1] = rgb[1]; pixels[at + 2] = rgb[2];
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
for (let i = 0; i < 40; i++) writeFileSync(join(source, `${String(i).padStart(2, "0")}.png`), png(100, 100, [80 + i * 3, 150, 180]));
writeFileSync(join(source, "大图.png"), png(2400, 1600, (x, y) => x % 120 === 0 || y % 120 === 0 ? [32, 32, 32] : [Math.round(x / 2400 * 255), Math.round(y / 1600 * 255), 120]));

const PORT = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4447);
const DRIVER = `http://127.0.0.1:${PORT}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
async function wd(method, path, body) {
  const response = await fetch(DRIVER + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(70000) });
  const result = await response.json();
  if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return path === "/session" && result.sessionId ? { sessionId: result.sessionId, capabilities: result.value } : result.value;
}
async function until(what, read) {
  const end = Date.now() + 30000;
  let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${what}${last ? ` (${last.message})` : ""}`);
}
function check(ok, label) { if (!ok) throw new Error(label); console.log(`✓ ${label}`); }
const driver = spawn(driverArg, ["--port", String(PORT), "--native-port", String(PORT + 1), "--native-driver", resolve(edgeArg)], {
  windowsHide: true,
  env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const stopped = new Promise((resolve) => driver.once("exit", resolve));
let base;
const exec = (script, args = []) => wd("POST", `${base}/execute/sync`, { script, args });
const find = async (xpath) => {
  const element = await wd("POST", `${base}/element`, { using: "xpath", value: xpath });
  return element[ELEMENT] ?? element.ELEMENT;
};
const click = async (text) => wd("POST", `${base}/element/${await find(`//button[normalize-space()='${text}']`)}/click`, {});
const image = () => exec(`const i = document.querySelector('.viewer-stage img'); if (!i || !i.complete || !i.naturalWidth || getComputedStyle(i).visibility !== 'visible') return null;
  const r = i.getBoundingClientRect(); return { src: i.src, w: i.naturalWidth, h: i.naturalHeight, physicalW: r.width * devicePixelRatio, physicalH: r.height * devicePixelRatio, physicalLeft: r.left * devicePixelRatio, physicalTop: r.top * devicePixelRatio, interpolation: getComputedStyle(i).imageRendering, dpr: devicePixelRatio };`);

try {
  await until("WebDriver 就绪", () => fetch(`${DRIVER}/status`).then((r) => r.ok));
  const forcedDpr = process.env.KINSHOKO_VIEWER_DPR;
  const additionalBrowserArguments = forcedDpr ? [`force-device-scale-factor=${Number(forcedDpr)}`] : [];
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview"), additionalBrowserArguments } } } } });
  base = `/session/${session.sessionId}`;
  const name = await until("建库引导", () => find("//label[contains(., '资料库名称')]/input"));
  await wd("POST", `${base}/element/${name}/clear`, {});
  await wd("POST", `${base}/element/${name}/value`, { text: "原图查看器验证" });
  await exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]", [parent]);
  await click("选择存放位置…");
  await click("建立资料库");
  await until("打开资料库", () => find("//h1[normalize-space()='原图查看器验证']"));
  check(true, "在独立数据目录建立测试资料库");
  await exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]", [source]);
  await click("导入文件夹…");
  await until("导入完成", () => find("//*[contains(normalize-space(), '导入完成：新增 41 张')]"));
  check(true, "导入 41 张测试参考图，未下载打标模型");
  const card = await until("大图卡片", () => exec("return [...document.querySelectorAll('.card')].find(c => Math.abs(c.offsetHeight / c.offsetWidth - 2/3) < .02)"));
  await wd("POST", `${base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
    { type: "pointerMove", duration: 0, origin: card, x: 0, y: 0 },
    { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 80 },
    { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
  ] }] });
  const fitted = await until("真实双击打开查看器", image);
  check(fitted.w < 2400 && Math.abs(fitted.physicalW - fitted.w) < 0.01 && Math.abs(fitted.physicalH - fitted.h) < 0.01, "适应窗口按设备像素 1:1 显示派生图");
  await click("原图像素");
  const original = await until("原图解码", image);
  if (forcedDpr) check(Math.abs(original.dpr - Number(forcedDpr)) < 0.001, "WebView2 使用请求的测试 DPR");
  check(original.w === 2400 && original.h === 1600 && Math.abs(original.physicalW - 2400) < 0.01 && Math.abs(original.physicalH - 1600) < 0.01, "原图像素在真实 WebView2 中对齐（DPR " + original.dpr + "）");
  check(Math.abs(original.physicalLeft - Math.round(original.physicalLeft)) < 0.01 && Math.abs(original.physicalTop - Math.round(original.physicalTop)) < 0.01, "图片起点落在完整设备像素上");
  for (let i = 0; i < 4; i++) await wd("POST", `${base}/element/${await find("//button[@aria-label='放大']")}/click`, {});
  const enlarged = await until("放大", image);
  check(enlarged.w === 2400 && enlarged.interpolation === "pixelated", "超过 200% 仍用原图并按像素放大");
  await click("适应窗口");
  await until("派生图", image);
  const fonts = await wd("POST", `${base}/execute/async`, { script: `const done = arguments[arguments.length - 1]; Promise.all([document.fonts.load('400 14px "Kinshoko Inter"', 'Kinshoko'), document.fonts.load('500 14px "Kinshoko Inter"', 'Library'), document.fonts.load('600 14px "Kinshoko Inter"', 'Reference'), document.fonts.load('400 14px "Kinshoko Han"', '参考图')]).then(v => done(v.every(f => f.length > 0 && f.every(x => x.status === 'loaded'))));`, args: [] });
  check(fonts, "全部随软件分发的字体离线加载成功");
  const fitAfterFonts = await until("字体加载后派生图稳定", image);
  check(Math.abs(fitAfterFonts.physicalLeft - Math.round(fitAfterFonts.physicalLeft)) < 0.01 && Math.abs(fitAfterFonts.physicalTop - Math.round(fitAfterFonts.physicalTop)) < 0.01, "字体加载后的派生图起点对齐设备像素");
  const screenshot = await wd("GET", `${base}/screenshot`);
  writeFileSync(join(output, "viewer.png"), Buffer.from(screenshot, "base64"));
  await click("返回图片墙");
  check(await exec("return document.activeElement?.dataset.id === arguments[0].dataset.id", [card]), "返回后焦点交还刚才查看的卡片");

  const anchor = await exec(`const wall = document.querySelector('.wall'); wall.scrollTop = 720; wall.dispatchEvent(new Event('scroll'));
    const top = wall.getBoundingClientRect().top; const cards = [...wall.querySelectorAll('.card')].map(c => ({ id: c.dataset.id, r: c.getBoundingClientRect() })).filter(c => c.r.bottom > top + 8 && c.r.top < top + wall.clientHeight).sort((a,b) => a.r.top - b.r.top || a.r.left - b.r.left);
    return { id: cards[0].id, offset: cards[0].r.top - top };`);
  const reading = await exec(`const wall = document.querySelector('.wall'); const top = wall.getBoundingClientRect().top;
    const card = [...wall.querySelectorAll('.card')].find(c => { const r = c.getBoundingClientRect(); return r.top >= top && r.bottom <= top + wall.clientHeight; });
    card.focus({preventScroll:true}); return { id: card.dataset.id, top: wall.scrollTop };`);
  const key = async (value) => wd("POST", `${base}/actions`, { actions: [{type:"key",id:"keyboard",actions:[{type:"keyDown",value},{type:"keyUp",value}]}] });
  await key("\uE007"); // Enter
  await until("键盘打开查看器", image);
  await key("\uE00C"); // Escape
  await until("键盘返回图片墙", () => exec("return !document.querySelector('.viewer')"));
  check(await exec("return document.activeElement?.dataset.id === arguments[0].id && Math.abs(document.querySelector('.wall').scrollTop - arguments[0].top) < .1", [reading]), "滚动后用回车查看，Esc 返回同一位置和焦点");
  const anchorOffset = () => exec(`const c = document.querySelector('[data-id="' + arguments[0] + '"]'); const wall = document.querySelector('.wall'); if (!c || c.getAnimations().some(a => a.playState === 'running')) return null; return c.getBoundingClientRect().top - wall.getBoundingClientRect().top;`, [anchor.id]);
  const anchorStable = async () => {
    const moving = await exec("return document.querySelector('.sidebar-slot').getAnimations().some(a => a.playState === 'running')");
    const offset = await anchorOffset();
    return !moving && offset !== null && Math.abs(offset - anchor.offset) < 1;
  };
  await click("收起侧栏");
  await until("收起侧栏锚点稳定", anchorStable);
  await click("展开侧栏");
  await until("展开侧栏锚点稳定", anchorStable);
  check(true, "侧栏往返重排保持同一张图的偏移");
  await wd("POST", `${base}/window/rect`, { width: 1050, height: 800 });
  await until("窗口变窄锚点稳定", anchorStable);
  await wd("POST", `${base}/window/rect`, { width: 1280, height: 800 });
  await until("窗口变宽锚点稳定", anchorStable);
  check(true, "原生窗口宽度往返保持同一张图的偏移");
  writeFileSync(join(output, "report.json"), JSON.stringify({ fitted, original, enlarged, fonts, fitAfterFonts, anchor, reading }, null, 2));
  console.log("查看器冒烟测试通过");
} catch (error) {
  if (base) {
    const state = await exec("return { url: location.href, html: document.body.innerHTML }").catch(() => null);
    writeFileSync(join(output, "failure.json"), JSON.stringify({ message: error.message, state }, null, 2));
    const screenshot = await wd("GET", `${base}/screenshot`).catch(() => null);
    if (screenshot) writeFileSync(join(output, "failure.png"), Buffer.from(screenshot, "base64"));
  }
  throw error;
} finally {
  if (base) await wd("DELETE", base).catch(() => {});
  driver.kill(); // tauri-driver 的 Windows Job 只结束本次测试的子进程。
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  const target = resolve(work);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("kinshoko-viewer47-")) throw new Error("拒绝清理非测试临时目录");
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
