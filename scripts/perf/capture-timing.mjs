// #127 / #129：F1 框选各阶段计时。可重复运行，修复前后同条件对比（结果见 docs/validation/capture-timing.md）。
//
// node scripts/perf/capture-timing.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]
//
// 独立应用 identifier、临时数据目录和 WebView 用户数据目录；不碰真实资料库。
// 生成合成原图（不同尺寸与格式）导入临时图库，逐张打开查看器后：
// - 用真实的全局快捷键按键（改绑的组合键，见 HOTKEY）触发框选，记录按键 → 框选窗口就绪 → 显示（可拖动）；
// - 在参考图内完成“复制”与“钉住”，记录确认 → 结果可用（剪贴板写好／钉图显示）。
// 每张图先冷后热（冷 = 该图在本进程内第一次截取），第一张同时是应用冷启动后的首截。
// 最后关掉主窗口（托盘常驻），隔 0／1.5／8 秒按快捷键，并记录常驻内存。
// 时间戳来自应用写到 KINSHOKO_CAPTURE_TIMING_LOG 的阶段标记（capture.timing，epoch ms）与本脚本的按键时刻。
// 冻结屏幕是整个桌面：本脚本不保存任何截图，只输出派生的毫秒数（report.json）。
//
// 选项（环境变量）：KINSHOKO_CAPTURE_FIXTURES（逗号分隔的 名称-宽x高.png|jpg|webp）、KINSHOKO_CAPTURE_REPEATS（默认 3）、
// KINSHOKO_CAPTURE_TRAY=0（不测托盘）、KINSHOKO_CAPTURE_TRAY_ONLY=1（只测托盘：启动后直接关主窗口）、
// KINSHOKO_CAPTURE_TOPMOST=0（不把测试主窗口置顶）、KINSHOKO_CAPTURE_LABEL、KINSHOKO_CAPTURE_TIMING_OUTPUT。
// 运行期间会移动光标、按 Ctrl+Shift+F9、在屏幕中央右键；需要 Python（ctypes、Pillow）。
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const [, , appArg, edgeArg, driverArg = "tauri-driver"] = process.argv;
if (!appArg || !edgeArg) throw new Error("node scripts/perf/capture-timing.mjs <kinshoko.exe> <msedgedriver.exe> [tauri-driver.exe]");
const python = process.env.KINSHOKO_PYTHON ?? "python";
const work = mkdtempSync(join(tmpdir(), "kinshoko-capture-timing-"));
const application = join(work, "kinshoko-capture-timing.exe");
const output = resolve(process.env.KINSHOKO_CAPTURE_TIMING_OUTPUT ?? "work/perf/capture-timing");
const marksFile = join(work, "marks.log");
const data = join(work, "app-data");
const parent = join(work, "libraries");
const source = join(work, "source");
const repeats = Number(process.env.KINSHOKO_CAPTURE_REPEATS ?? 3);
for (const dir of [output, parent, source, join(work, "roaming"), join(work, "local")]) mkdirSync(dir, { recursive: true });
copyFileSync(resolve(appArg), application);

// 合成原图：渐变叠低幅噪声，压缩后的体积接近真实插画／照片。同一种子逐字节相同。
const FIXTURES = (process.env.KINSHOKO_CAPTURE_FIXTURES ?? "a-2400x1600.png,b-6000x4000.png,c-6000x4000.jpg,d-9000x6000.jpg,e-6000x4000.webp").split(",");
const generated = spawnSync(python, ["-I", "-c", `
import sys, random
from PIL import Image
out = sys.argv[1]
for spec in sys.argv[2:]:
    name, ext = spec.rsplit('.', 1)
    w, h = map(int, name.split('-')[1].split('x'))
    rng = random.Random(name)
    base = Image.linear_gradient('L').resize((w, h))
    noise = Image.frombytes('L', (w, h), rng.randbytes(w * h))
    r = Image.blend(base, noise, 0.25)
    g = Image.blend(base.transpose(Image.Transpose.ROTATE_90).resize((w, h)), noise, 0.15)
    b = Image.blend(base.transpose(Image.Transpose.FLIP_TOP_BOTTOM), noise, 0.35)
    im = Image.merge('RGB', (r, g, b))
    fmt = {'png': 'PNG', 'jpg': 'JPEG', 'webp': 'WEBP'}[ext]
    im.save(f"{out}/{spec}", fmt, **({'quality': 90} if fmt != 'PNG' else {}))
`, source, ...FIXTURES], { encoding: "utf8", windowsHide: true });
if (generated.status !== 0) throw new Error(generated.stderr);

const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4467);
const endpoint = `http://127.0.0.1:${port}`;
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const report = { tickets: [127, 129], windows: release(), sourceRevision: process.env.KINSHOKO_SOURCE_REVISION ?? "uncommitted", label: process.env.KINSHOKO_CAPTURE_LABEL ?? "", runs: [] };
async function wd(method, path, body) {
  const response = await fetch(endpoint + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return path === "/session" && result.sessionId ? { sessionId: result.sessionId, capabilities: result.value } : result.value;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, read, timeout = 30000, step = 100) {
  let last; const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (error) { last = error; } await sleep(step); }
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
const windows = () => invoke("plugin:window|get_all_windows");
const find = async (xpath) => { const element = await wd("POST", `${base}/element`, { using: "xpath", value: xpath }); return element[elementKey] ?? element.ELEMENT; };
const click = async (text) => wd("POST", `${base}/element/${await find(`//button[normalize-space()='${text}' or @aria-label='${text}' or starts-with(@aria-label,'${text}，')]`)}/click`, {});
const viewerImage = () => exec(`const i = document.querySelector('.viewer-stage img'); if (!i?.complete || !i.naturalWidth || getComputedStyle(i).visibility !== 'visible') return null; const r=i.getBoundingClientRect(); return { left:Math.round(r.left*devicePixelRatio), top:Math.round(r.top*devicePixelRatio), width:Math.round(r.width*devicePixelRatio), height:Math.round(r.height*devicePixelRatio), name: document.querySelector('.viewer-title')?.textContent ?? '' };`);

// 开发机上常驻的已安装 Kinshoko 占着 F1：测试实例把框选改绑到不冲突的组合键，之后走同一条
// 全局快捷键 → on_shortcut → capture::start 路径。绝不按 F1，免得触发画师自己的实例。
const HOTKEY = "Ctrl+Shift+F9";
/** 真实按键：光标放到参考图中央（决定冻结哪台显示器），再经 keybd_event 按 HOTKEY。返回按下时刻（epoch ms）。 */
function pressHotkey(x, y) {
  const run = spawnSync(python, ["-I", "-c", `
import ctypes, sys, time
u = ctypes.windll.user32
u.SetCursorPos(int(sys.argv[1]), int(sys.argv[2]))
time.sleep(0.05)
u.keybd_event(0x11, 0, 0, 0)
u.keybd_event(0x10, 0, 0, 0)
t = time.time() * 1000
u.keybd_event(0x78, 0, 0, 0)
u.keybd_event(0x78, 0, 2, 0)
u.keybd_event(0x10, 0, 2, 0)
u.keybd_event(0x11, 0, 2, 0)
print(f"{t:.1f}")
`, String(x), String(y)], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr);
  return Number(run.stdout.trim());
}
/** 只把本次测试 exe 的主窗口（标题 Kinshoko）置顶；不碰其他进程的窗口。 */
function topmost() {
  const run = spawnSync(python, ["-I", "-c", `
import ctypes, ctypes.wintypes as w, sys
u = ctypes.windll.user32; k = ctypes.windll.kernel32
found = []
def cb(h, _):
    pid = w.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    hp = k.OpenProcess(0x1000, False, pid.value)
    if not hp: return True
    buf = ctypes.create_unicode_buffer(1024); n = w.DWORD(1024)
    ok = k.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(n)); k.CloseHandle(hp)
    t = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, t, 256)
    if ok and buf.value.lower().endswith(sys.argv[1].lower()) and t.value == "Kinshoko" and u.IsWindowVisible(h):
        found.append(h)
    return True
u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)(cb), 0)
for h in found: u.SetWindowPos(h, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
print(len(found))
`, basename(application)], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0 || run.stdout.trim() !== "1") throw new Error(`无法置顶测试主窗口：${run.stderr || run.stdout}`);
}
/** 在 (x, y) 右键：框选窗口置顶铺满显示器，右键即取消，不依赖它拿到键盘焦点。只在已显示后调用。 */
function rightClick(x, y) {
  const run = spawnSync(python, ["-I", "-c", "import ctypes,sys; u=ctypes.windll.user32; u.SetCursorPos(int(sys.argv[1]),int(sys.argv[2])); u.mouse_event(8,0,0,0,0); u.mouse_event(16,0,0,0,0)", String(x), String(y)], { windowsHide: true });
  if (run.status !== 0) throw new Error("右键失败");
}
/** 测试 exe 及其全部子进程（WebView2）的进程数、工作集与私有内存（MB），与 docs/validation/resident-memory.md 同口径。 */
function memory() {
  const run = spawnSync("powershell", ["-NoProfile", "-Command", `
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$ids = @($all | Where-Object { $_.Name -eq '${basename(application)}' } | ForEach-Object { [int]$_.ProcessId })
if ($ids.Count -eq 0) { 'none'; exit }
do { $grown = $false; foreach ($p in $all) { if (($ids -contains [int]$p.ParentProcessId) -and -not ($ids -contains [int]$p.ProcessId)) { $ids += [int]$p.ProcessId; $grown = $true } } } while ($grown)
$ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
'{0} {1} {2}' -f $ps.Count, [math]::Round(($ps | Measure-Object WorkingSet64 -Sum).Sum / 1MB), [math]::Round(($ps | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB)
`], { encoding: "utf8", windowsHide: true });
  const [processes, workingSetMb, privateMb] = run.stdout.trim().split(" ").map(Number);
  return { processes, workingSetMb, privateMb };
}
function marks() {
  if (!existsSync(marksFile)) return [];
  return readFileSync(marksFile, "utf8").split("\n").filter(Boolean).map((line) => {
    const m = /^capture\.timing (.*) at=([\d.]+)$/.exec(line); if (!m) return null;
    const [name, ...rest] = m[1].split(" ");
    return { name, detail: rest.join(" "), at: Number(m[2]) };
  }).filter(Boolean);
}
const after = (list, since) => list.filter((m) => m.at >= since);
const first = (list, name) => list.find((m) => m.name === name);
const round = (v) => (v === undefined || Number.isNaN(v) ? null : Math.round(v));

/** 一次 F1：按键 → 显示，再在参考图内完成 action。返回各阶段相对按键的毫秒数。 */
async function capture(shown, action) {
  const before = await windows();
  const pressed = pressHotkey(shown.x + Math.floor(shown.width / 2), shown.y + Math.floor(shown.height / 2));
  const visible = await until("框选窗口已显示", async () => (await windows()).includes("capture") && (await native("is_visible", "capture")), 30000, 10);
  const seenVisible = Date.now();
  const origin = await native("inner_position", "capture");
  const region = { x: shown.x + Math.floor(shown.width / 4) - origin.x, y: shown.y + Math.floor(shown.height / 4) - origin.y, width: Math.max(4, Math.floor(shown.width / 8)), height: Math.max(4, Math.floor(shown.height / 8)) };
  const frozen = await desktop("frozen_screen");
  const readout = await desktop("capture_readout", { region, token: frozen.image.slice("screen/".length) });
  const confirmed = Date.now();
  await desktop("finish_capture", { region, action, token: frozen.image.slice("screen/".length) });
  let pinShown = null;
  if (action === "pin") {
    const label = await until("新钉图", async () => (await windows()).find((l) => l.startsWith("pin-") && !before.includes(l)), 30000, 10);
    await until("钉图已显示", () => native("is_visible", label), 30000, 10);
    pinShown = Date.now();
    // 钉图留着会盖住下一次的选区（走普通截图）：关掉它，并确认已关闭。
    await invoke("plugin:window|close", { label });
    await until("钉图已关闭", async () => !(await windows()).includes(label));
  }
  // 修复前框选窗口用完即销毁，修复后（#129）只隐藏：两种都算结束。
  await until("框选窗口已关闭", async () => !(await windows()).includes("capture") || !(await native("is_visible", "capture")));
  await sleep(300);
  const m = after(marks(), pressed - 5);
  const at = (name) => first(m, name)?.at;
  const rel = (t) => round(t - pressed);
  const finish = at("finish.begin");
  const stages = {
    keyToStart: rel(at("start")), grabbed: rel(at("grabbed")),
    windowBuilt: rel(at("window.built")), pageAsksFrozen: rel(at("frozen_screen")),
    pngBegin: rel(at("png.begin")), pngEnd: rel(at("png.end")),
    shown: rel(at("shown")), harnessSawVisible: rel(seenVisible),
    pngBytes: Number(/bytes=(\d+)/.exec(first(m, "png.end")?.detail ?? "")?.[1] ?? 0),
    references: Number(/references=(\d+)/.exec(first(m, "frozen")?.detail ?? "")?.[1] ?? -1),
    covered: Number(/covered=(\d+)/.exec(first(m, "frozen")?.detail ?? "")?.[1] ?? -1),
  };
  const result = {
    original: readout,
    confirmToFinishBegin: round(finish - confirmed),
    prepare: round(at("finish.prepared") - finish),
    finishEnd: round(at("finish.end") - finish),
    pinWindowBegin: round(at("pin.window.begin") - finish),
    pinReady: round(at("pin.ready") - finish),
    harnessPinShown: pinShown ? round(pinShown - confirmed) : null,
  };
  return { action, stages, result, visible: !!visible };
}

/** 中位数／最大值汇总，便于修复前后对比。 */
function summarize(r) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
  const stat = (a) => (a.length ? { median: median(a), max: Math.max(...a), n: a.length } : null);
  const rest = r.runs.filter((x) => !x.appColdStart);
  const out = {
    firstCaptureShown: r.runs.find((x) => x.appColdStart)?.stages.shown ?? null,
    keyToShown: stat(rest.map((x) => x.stages.shown)),
    keyToWindowReady: stat(rest.map((x) => x.stages.windowBuilt)),
    frozenPng: stat(rest.map((x) => x.stages.pngEnd - x.stages.pngBegin)),
    referenceRuns: `${r.runs.filter((x) => x.result.original).length}/${r.runs.length}`,
    images: {},
  };
  for (const image of [...new Set(r.runs.map((x) => x.image))].sort()) {
    const of = (action) => r.runs.filter((x) => x.image === image && x.action === action && x.result.original);
    out.images[image] = { copyToClipboard: of("copy").map((x) => x.result.finishEnd), pinToShown: of("pin").map((x) => x.result.harnessPinShown) };
  }
  if (r.tray) out.tray = r.tray.map((t) => ({ gapMs: t.gapMs, shown: t.shown }));
  if (r.memory) out.memory = r.memory;
  return out;
}

const driver = spawn(driverArg, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { windowsHide: true, env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1", KINSHOKO_CAPTURE_TIMING_LOG: marksFile }, stdio: ["ignore", "inherit", "inherit"] });
const stopped = new Promise((done) => driver.once("exit", done));
try {
  await until("WebDriver", () => fetch(`${endpoint}/status`).then((r) => r.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
  base = `/session/${session.sessionId}`;
  await wd("POST", `${base}/timeouts`, { script: 60000 });
  // KINSHOKO_CAPTURE_TRAY_ONLY=1：不建库、不截主窗口，启动后直接关主窗口，只测托盘下的按键与常驻内存。
  const trayOnly = process.env.KINSHOKO_CAPTURE_TRAY_ONLY === "1";
  if (trayOnly) {
    await until("建库引导", () => find("//label[contains(., '图库名称')]/input"));
    await invoke("rebind_shortcut", { action: "capture", accelerator: HOTKEY });
  } else {
    const name = await until("建库引导", () => find("//label[contains(., '图库名称')]/input"));
    await wd("POST", `${base}/element/${name}/clear`, {});
    await wd("POST", `${base}/element/${name}/value`, { text: "框选计时" });
    await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [parent]); await click("选择存放位置…"); await click("建立图库");
    // #113：没有“当前图库”，新库显示为侧栏分组头“名称（N 张）”。导入经拆分按钮菜单和导入对话框（#98）。
    await until("打开图库", () => find("//nav[@aria-label='查找范围']//*[@data-library-id]//button[contains(@class,'lib-head-name') and starts-with(@aria-label,'框选计时（') and not(@disabled)]"));
    await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [source]);
    await click("更多导入方式");
    await wd("POST", `${base}/element/${await until("整个文件夹菜单项", () => find("//*[@role='menuitem' and normalize-space()='整个文件夹…']"))}/click`, {});
    const librarySelect = "[...document.querySelectorAll('.k-import-dialog select')].find(s=>s.labels?.[0]?.querySelector('.k-field-label')?.textContent.trim()==='放到图库')";
    await until("导入对话框", () => exec(`return !!${librarySelect}?.options[1]`));
    await exec(`const s=${librarySelect};s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until("开始导入可用", () => exec("return [...document.querySelectorAll('.k-import-dialog button')].some(b=>b.textContent.trim()==='开始导入'&&!b.disabled)"));
    await click("开始导入");
    await until("导入完成", () => exec("const c=document.querySelector('section[aria-label=导入结果]');return c?.textContent.includes('导入完成');"), 180000);
    await click("关闭导入结果");
    await invoke("rebind_shortcut", { action: "capture", accelerator: HOTKEY });
    // 开发机桌面上还有别的窗口；让测试主窗口置顶，参考图不被遮挡，选区才走原图（参考视图）路径。
    if (process.env.KINSHOKO_CAPTURE_TOPMOST !== "0") topmost();
    await until("导入全部参考图", async () => (await exec("return document.querySelectorAll('.card').length")) === FIXTURES.length, 120000);
    // 等缩略图与后台任务安静下来，冷热只针对截取本身。
    await sleep(5000);
    for (let index = 0; index < FIXTURES.length; index++) {
      const card = await exec("return document.querySelectorAll('.card')[arguments[0]]", [index]);
      await wd("POST", `${base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: card, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 80 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
      await wd("DELETE", `${base}/actions`);
      const fitted = await until("查看器显示原图", viewerImage, 60000);
      await sleep(1500);
      const mainOrigin = await native("inner_position", "main");
      const shown = { x: mainOrigin.x + fitted.left, y: mainOrigin.y + fitted.top, width: fitted.width, height: fitted.height };
      for (let pass = 0; pass < repeats; pass++) for (const action of ["copy", "pin"]) {
        const run = await capture(shown, action);
        const entry = { image: fitted.name, index, pass, cache: pass === 0 ? "cold" : "warm", appColdStart: index === 0 && pass === 0 && action === "copy", ...run };
        report.runs.push(entry);
        console.log(JSON.stringify({ image: entry.image, pass, action, shown: run.stages.shown, png: run.stages.pngEnd - run.stages.pngBegin, built: run.stages.windowBuilt, refs: run.stages.references, covered: run.stages.covered, original: run.result.original, finishEnd: run.result.finishEnd, pinReady: run.result.pinReady }));
        await sleep(400);
      }
      await wd("POST", `${base}/actions`, { actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value: "" }, { type: "keyUp", value: "" }] }] });
      await until("回到图片墙", async () => !(await exec("return document.querySelector('.viewer-stage')")));
    }
  }
  // 托盘常驻（ADR-0004）：关掉主窗口只销毁它的 WebView，画画时按快捷键。只看阶段标记，右键取消。
  // 间隔 8 秒模拟画一会儿再截；1.5 秒模拟连续截取。WebDriver 会话随主窗口结束，之后不再用它。
  if (process.env.KINSHOKO_CAPTURE_TRAY !== "0") {
    report.memory = { mainOpen: memory() };
    await invoke("plugin:window|close", { label: "main" }).catch(() => {});
    base = null;
    await sleep(8000);
    report.memory.trayIdle = memory();
    report.tray = [];
    for (const gap of [0, 1500, 8000, 1500]) {
      await sleep(gap);
      const pressed = pressHotkey(1280, 720);
      const shown = await until("托盘下框选窗口显示", () => first(after(marks(), pressed - 5), "shown"), 30000, 20);
      const m = after(marks(), pressed - 5);
      const rel = (name) => round(first(m, name)?.at - pressed);
      const entry = { gapMs: gap, keyToStart: rel("start"), grabbed: rel("grabbed"), windowBuilt: rel("window.built"), pageAsksFrozen: rel("frozen_screen"), pngBegin: rel("png.begin"), pngEnd: rel("png.end"), shown: round(shown.at - pressed) };
      report.tray.push(entry);
      console.log(JSON.stringify({ tray: entry }));
      await sleep(300);
      rightClick(1280, 720);
      await sleep(1200);
    }
    report.memory.trayAfterCaptures = memory();
    console.log(JSON.stringify({ memory: report.memory }));
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error);
  report.lastMarks = marks().slice(-40);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.summary = summarize(report);
  console.log(JSON.stringify(report.summary, null, 2));
  writeFileSync(join(output, `report${report.label ? `-${report.label}` : ""}.json`), JSON.stringify(report, null, 2));
  if (base) { try { await wd("DELETE", base); } catch {} }
  driver.kill(); await Promise.race([stopped, sleep(3000)]);
  const actual = realpathSync(work); const tempRoot = realpathSync(tmpdir());
  if (dirname(actual) === tempRoot && basename(actual).startsWith("kinshoko-capture-timing-")) rmSync(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
