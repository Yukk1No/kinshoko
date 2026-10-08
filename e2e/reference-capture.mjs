// #81 / spec #78 T16：真实 WebView2 来源登记、F1 生产命令、原生剪贴板往返。
// node e2e/reference-capture.mjs <isolated-identifier kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]
// 与其他原生测试串行运行；KINSHOKO_SKIP_AUTOSTART + 独立临时数据目录。
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, driverArg = "tauri-driver"] = process.argv;
if (!appArg || !edgeArg) throw new Error("node e2e/reference-capture.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const work = mkdtempSync(join(tmpdir(), "kinshoko-spec78-t16-"));
const application = join(work, "kinshoko-spec78-t16.exe");
const output = resolve(process.env.KINSHOKO_CAPTURE_OUTPUT ?? "work/native/reference-capture");
const data = join(work, "app-data");
const parent = join(work, "libraries");
const source = join(work, "source");
for (const dir of [output, parent, source, join(work, "roaming"), join(work, "local")]) mkdirSync(dir, { recursive: true });
copyFileSync(resolve(appArg), application);
const table = Array.from({ length: 256 }, (_, c) => { for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function chunk(type, bytes) {
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff; for (const byte of body) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, tail]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(2400); header.writeUInt32BE(1600, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc((2400 * 4 + 1) * 1600);
for (let y = 0; y < 1600; y++) for (let x = 0; x < 2400; x++) {
  const at = y * (2400 * 4 + 1) + 1 + x * 4;
  pixels[at] = x % 256; pixels[at + 1] = y % 256; pixels[at + 2] = x % 2 * 255; pixels[at + 3] = 255;
}
writeFileSync(join(source, "original-detail.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4457);
const endpoint = `http://127.0.0.1:${port}`;
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const report = { story: [45, 46, 48, 49], ticket: 81, windows: release(), sourceRevision: process.env.KINSHOKO_SOURCE_REVISION ?? "uncommitted", checks: [] };
function check(ok, label) { if (!ok) throw new Error(label); report.checks.push(label); console.log(`✓ ${label}`); }
async function wd(method, path, body) {
  const response = await fetch(endpoint + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return path === "/session" && result.sessionId ? { sessionId: result.sessionId, capabilities: result.value } : result.value;
}
async function until(label, read) {
  let last; const end = Date.now() + 30000;
  while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (error) { last = error; } await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(`等待超时：${label}${last ? ` (${last.message})` : ""}`);
}
let base;
const exec = (script, args = []) => wd("POST", `${base}/execute/sync`, { script, args });
async function invoke(command, args = {}) {
  const result = await wd("POST", `${base}/execute/async`, { script: `const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ok:true,value}), error => done({ok:false,error:String(error)}));`, args: [command, args] });
  if (!result.ok) throw new Error(`${command}: ${result.error}`);
  return result.value;
}
const desktop = (name, args) => invoke(`plugin:desktop|${name}`, args);
const native = (name, label) => invoke(`plugin:window|${name}`, { label });
const find = async (xpath) => { const element = await wd("POST", `${base}/element`, { using: "xpath", value: xpath }); return element[elementKey] ?? element.ELEMENT; };
const click = async (text) => wd("POST", `${base}/element/${await find(`//button[normalize-space()='${text}']`)}/click`, {});
const image = () => exec(`const i = document.querySelector('.viewer-stage img'); if (!i?.complete || !i.naturalWidth || getComputedStyle(i).visibility !== 'visible') return null; const r=i.getBoundingClientRect(); return { left:Math.round(r.left*devicePixelRatio), top:Math.round(r.top*devicePixelRatio), width:Math.round(r.width*devicePixelRatio), height:Math.round(r.height*devicePixelRatio), naturalWidth:i.naturalWidth, src:i.currentSrc, dpr:devicePixelRatio };`);
const windows = () => invoke("plugin:window|get_all_windows");
async function capture(shown, action) {
  // 真实原生抓屏和冻结窗口；来源由实际 Viewer/PinView 报告。只以公共命令提交选区。
  await desktop("start_capture");
  await until("冻结窗口已显示", () => native("is_visible", "capture"));
  const origin = await native("inner_position", "capture");
  const x = shown.x + Math.floor(shown.width / 4);
  const y = shown.y + Math.floor(shown.height / 4);
  const width = Math.max(4, Math.floor(shown.width / 8));
  const height = Math.max(4, Math.floor(shown.height / 8));
  if (x < origin.x || y < origin.y) throw new Error("当前光标显示器不包含测试参考图；请将光标与测试窗口置于同一显示器");
  const region = { x: x - origin.x, y: y - origin.y, width, height };
  await desktop("finish_capture", { region, action });
  await until("冻结窗口已关闭", async () => !(await windows()).includes("capture"));
  return { offsetX: x - shown.x, offsetY: y - shown.y, width, height };
}
function originalRegion(pin, shown, selected) {
  const baseCrop = pin.crop ?? { x: 0, y: 0, width: pin.content.sourceWidth, height: pin.content.sourceHeight };
  const corners = [];
  for (const x of [selected.offsetX / shown.width, (selected.offsetX + selected.width) / shown.width]) for (const y of [selected.offsetY / shown.height, (selected.offsetY + selected.height) / shown.height]) {
    let [u, v] = [[x, y], [y, 1 - x], [1 - x, 1 - y], [1 - y, x]][pin.placement.rotation % 4];
    if (pin.placement.flipH) u = 1 - u; if (pin.placement.flipV) v = 1 - v;
    corners.push([u * baseCrop.width, v * baseCrop.height]);
  }
  // 小误差只来自测试端 JS 浮点；生产核心用整数比例向外取整。
  const left = Math.floor(Math.min(...corners.map(p => p[0])) + 1e-8);
  const top = Math.floor(Math.min(...corners.map(p => p[1])) + 1e-8);
  const right = Math.ceil(Math.max(...corners.map(p => p[0])) - 1e-8);
  const bottom = Math.ceil(Math.max(...corners.map(p => p[1])) - 1e-8);
  return { x: baseCrop.x + left, y: baseCrop.y + top, width: right - left, height: bottom - top };
}
async function newPin(before) {
  const label = await until("新原生钉图", async () => (await windows()).find(label => label.startsWith("pin-") && !before.includes(label)));
  const pin = label.slice(4);
  const frame = await until("钉图首帧", async () => { const f = await desktop("pin_frame", { pin }); return f && f.content.width > 0 ? f : null; });
  await until("钉图已显示", () => native("is_visible", label));
  return frame;
}
function readClipboardRoundTrip(entry) {
  const path = join(data, "captures", `${entry.id}.png`);
  const python = spawnSync(process.env.KINSHOKO_PYTHON ?? "python", ["-c", "from PIL import Image; import json,sys; im=Image.open(sys.argv[1]).convert('RGBA'); print(json.dumps({'size':im.size,'corners':[im.getpixel((0,0)),im.getpixel((im.width-1,0)),im.getpixel((0,im.height-1)),im.getpixel((im.width-1,im.height-1))]}))", path], { windowsHide: true, encoding: "utf8" });
  if (python.status !== 0) throw new Error(python.stderr || "剪贴板往返文件读取失败");
  copyFileSync(path, join(output, "clipboard-roundtrip.png"));
  return JSON.parse(python.stdout);
}
function sameRegion(a, b) { return ["x", "y", "width", "height"].every(key => a?.[key] === b?.[key]); }
function expectedCorners(crop, placement) {
  let corners = [[crop.x, crop.y], [crop.x + crop.width - 1, crop.y], [crop.x, crop.y + crop.height - 1], [crop.x + crop.width - 1, crop.y + crop.height - 1]];
  if (placement.flipH) corners = [corners[1], corners[0], corners[3], corners[2]];
  if (placement.flipV) corners = [corners[2], corners[3], corners[0], corners[1]];
  for (let r = 0; r < placement.rotation % 4; r++) corners = [corners[2], corners[0], corners[3], corners[1]];
  return corners.map(([x, y]) => [x % 256, y % 256, x % 2 * 255, 255]);
}
const driver = spawn(driverArg, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { windowsHide: true, env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1" }, stdio: ["ignore", "inherit", "inherit"] });
const stopped = new Promise(done => driver.once("exit", done));
try {
  await until("WebDriver", () => fetch(`${endpoint}/status`).then(r => r.ok));
  const dpr = process.env.KINSHOKO_CAPTURE_DPR;
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview"), additionalBrowserArguments: dpr ? [`force-device-scale-factor=${Number(dpr)}`] : [] } } } } });
  base = `/session/${session.sessionId}`;
  report.capabilities = session.capabilities;
  await wd("POST", `${base}/timeouts`, { script: 60000 });
  const name = await until("建库引导", () => find("//label[contains(., '资料库名称')]/input"));
  await wd("POST", `${base}/element/${name}/clear`, {});
  await wd("POST", `${base}/element/${name}/value`, { text: "T16 原图框选" });
  await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [parent]); await click("选择存放位置…"); await click("建立资料库");
  await until("测试资料库", () => find("//h1[normalize-space()='T16 原图框选']"));
  await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [source]); await click("导入文件夹…");
  const card = await until("导入参考图", () => exec("return document.querySelector('.card')"));
  await wd("POST", `${base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: card, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 80 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  const fitted = await until("缩小查看器", image);
  report.dpr = fitted.dpr;
  if (dpr) check(Math.abs(fitted.dpr - Number(dpr)) < 0.001, "WebView2 使用指定的测试 DPR");
  check(fitted.naturalWidth < 2400, "真实查看器缩小显示 2400×1600 原图");
  const sourcePath = new URL(fitted.src).pathname.split("/").filter(Boolean);
  const mainOrigin = await native("inner_position", "main");
  const shown = { x: mainOrigin.x + fitted.left, y: mainOrigin.y + fitted.top, width: fitted.width, height: fitted.height };
  await new Promise(done => setTimeout(done, 500));
  const selected = await capture(shown, "copy");
  check((await desktop("capture_history")).length === 0, "查看器原图复制不增加截图历史");
  const beforePin = await windows();
  const pinnedSelection = await capture(shown, "pin");
  const frame = await newPin(beforePin);
  const expected = originalRegion({ ...frame.pin, crop: null, placement: { flipH: false, flipV: false, rotation: 0 } }, shown, pinnedSelection);
  report.viewer = { fitted, sourcePath, shown, selected, pinnedSelection, expected, pin: frame.pin };
  check(frame.pin.content.kind === "reference" && frame.pin.content.libraryId === sourcePath[0] && frame.pin.content.imageId === sourcePath[1], "查看器 F1 钉图保留明确资料库与原图来源");
  check(sameRegion(frame.pin.crop, expected), "查看器 F1 钉图保留原图裁切");
  check((await desktop("capture_history")).length === 0, "查看器原图钉住不增加截图历史");
  // 使用真正的 F3 生产入口读回系统剪贴板；该动作才新增第一条截图历史。
  await desktop("pin_clipboard");
  let entries = await desktop("capture_history");
  let clipboard = readClipboardRoundTrip(entries[0]);
  check(clipboard.size[0] === expected.width && clipboard.size[1] === expected.height, "系统剪贴板保留原图选区尺寸");
  check(JSON.stringify(clipboard.corners) === JSON.stringify(expectedCorners(expected, { flipH: false, flipV: false, rotation: 0 })), "系统剪贴板四角保留逐像素原图细节");
  // 先把所有其它钉图移走，避免测试源被另一个真实置顶窗口遮挡。
  for (const label of await windows()) if (label.startsWith("pin-") && label !== `pin-${frame.pin.id}`) await desktop("move_pin", { pin: label.slice(4), x: shown.x + shown.width + 50, y: shown.y });
  await desktop("turn_pin", { pin: frame.pin.id, turn: "flipHorizontal" });
  await desktop("turn_pin", { pin: frame.pin.id, turn: "rotateClockwise" });
  await desktop("zoom_pin", { pin: frame.pin.id, scale: 0.5, anchorX: frame.content.x, anchorY: frame.content.y });
  await new Promise(done => setTimeout(done, 1000));
  const prior = await desktop("pin_frame", { pin: frame.pin.id });
  const beforeHistory = entries.length;
  const part = await capture(prior.content, "copy");
  check((await desktop("capture_history")).length === beforeHistory, "已有局部变换后的复制不增加截图历史");
  const transformedCrop = originalRegion(prior.pin, prior.content, part);
  const beforeTransformedPin = await windows();
  await capture(prior.content, "pin");
  const transformedPin = await newPin(beforeTransformedPin);
  check(sameRegion(transformedPin.pin.crop, transformedCrop) && transformedPin.pin.content.libraryId === prior.pin.content.libraryId && transformedPin.pin.content.imageId === prior.pin.content.imageId && transformedPin.pin.placement.flipH === prior.pin.placement.flipH && transformedPin.pin.placement.rotation === prior.pin.placement.rotation, "已有局部变换后的钉住保留同一原图来源、裁切和方向");
  check((await desktop("capture_history")).length === beforeHistory, "已有局部变换后的钉住不增加截图历史");
  await desktop("pin_clipboard");
  entries = await desktop("capture_history"); clipboard = readClipboardRoundTrip(entries[0]);
  check(clipboard.size[0] === transformedCrop.height && clipboard.size[1] === transformedCrop.width, "已有局部翻转旋转后剪贴板仍保留原图尺寸");
  check(JSON.stringify(clipboard.corners) === JSON.stringify(expectedCorners(transformedCrop, prior.pin.placement)), "已有局部翻转旋转后剪贴板四角与原图对应");
  report.transformed = { prior, selected: part, crop: transformedCrop, clipboard, pin: transformedPin.pin };
  const beforeOutside = entries.length;
  const outside = await capture({ x: mainOrigin.x, y: mainOrigin.y, width: 80, height: 80 }, "copy");
  entries = await desktop("capture_history");
  check(entries.length === beforeOutside + 1 && entries[0].width === outside.width && entries[0].height === outside.height, "参考图外的 F1 复制继续保存普通屏幕截图");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error);
  if (base) { try { writeFileSync(join(output, "failure.html"), await wd("GET", `${base}/source`)); } catch {} }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (base) { try { await wd("DELETE", base); } catch {} }
  driver.kill(); await Promise.race([stopped, new Promise(done => setTimeout(done, 3000))]);
  const actual = realpathSync(work); const tempRoot = realpathSync(tmpdir());
  if (dirname(actual) === tempRoot && basename(actual).startsWith("kinshoko-spec78-t16-")) rmSync(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
