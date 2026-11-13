// #418 第 2 步：图片墙叠放图集与原位托盘的日间、夜间截图，可选录屏（悬停拿起、打开托盘、关上托盘）。
// 墙上的图来自一个合成的 Eagle 资料库：几个 pixiv 多页作品（链接是作品页、文件名带 _p<n>），夹着普通单张。
// 录屏用 ffmpeg 抓桌面上窗口所在的区域，窗口必须在前台、不被挡住：加 --record 才录，会占用屏幕。
// Usage: node e2e/image-sets-418.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录> [--record]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildFixture } from "./image-sets-418.fixture.mjs";
import { createDriver } from "./lib/driver.mjs";

const [, , appArg, edgeArg, outArg, ...flags] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/image-sets-418.mjs <kinshoko.exe> <msedgedriver.exe> <out> [--record]");
const record = flags.includes("--record");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4618;
const driverUrl = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

// ---- 合成的 Eagle 资料库（见 image-sets-418.fixture.mjs）----
const { eagle, items } = buildFixture(work);

// --fixture-only：只生成 Eagle 资料库就退出（不启动应用，不占屏幕），用来检查数据。
if (flags.includes("--fixture-only")) { console.log(`Fixture: ${eagle} (${items} items)`); process.exit(0); }

// ---- WebDriver ----
const { wd, until, quitOwnApp } = createDriver({ driverUrl, application });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
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
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: JSON.stringify(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async element(css) { return until("find " + css, async () => (await wd("POST", `${this.base}/element`, { using: "css selector", value: css }))[ELEMENT]); }
  async click(css) { await wd("POST", `${this.base}/element/${await this.element(css)}/click`, {}); }
  /** 真实的指针动作：移到元素中心（可带偏移），按住修饰键单击。 */
  async pointer(css, { click = false, ctrl = false, dx = 0, dy = 0, button = 0 } = {}) {
    const id = await this.element(css);
    const actions = [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", origin: { [ELEMENT]: id }, x: dx, y: dy, duration: 120 },
      ...(click ? [{ type: "pointerDown", button }, { type: "pointerUp", button }] : []),
    ] }];
    if (ctrl) actions.unshift({ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "" }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: "" }] });
    await wd("POST", `${this.base}/actions`, { actions });
    await wd("DELETE", `${this.base}/actions`);
  }
  key(value) { return wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }] }); }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  /** 指针移到窗口左下角，不停在任何一格上。 */
  park() { return wd("POST", `${this.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 120, y: 880 }] }] }); }
  close() { return wd("DELETE", this.base); }
  async theme(name) { await this.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]); await delay(500); }
  async shot(name) {
    for (const theme of ["light", "dark"]) {
      await this.theme(theme);
      writeFileSync(join(work, `${name}-${theme === "light" ? "day" : "night"}.png`), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64"));
    }
    await this.theme("light");
    console.log("shot", name);
  }
}
/**
 * 应用窗口在屏幕上的矩形与主屏的尺寸，都按物理像素量（先声明感知 DPI）。WebView2 的设备像素比与屏幕坐标对不上，
 * 所以录屏先录整个主屏，再按两者的比例裁出窗口。
 */
function windowOnScreen() {
  const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct R { public int L, T, Rt, B; } public static class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][W]::SetProcessDPIAware()
$p = Get-Process | Where-Object { $_.Path -eq $env:KINSHOKO_E2E_EXECUTABLE -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$r = New-Object R; [void][W]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
"$($r.L) $($r.T) $($r.Rt) $($r.B) $($b.Width) $($b.Height)"`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application } });
  const [l, t, r, b, sw, sh] = out.stdout.trim().split(/\s+/).map(Number);
  if (![l, t, r, b, sw, sh].every(Number.isFinite) || r <= l) throw new Error(`window rect: ${out.stdout} ${out.stderr}`);
  return { l, t, r, b, sw, sh };
}
/** 录一段：录整个主屏，跑完 act 后再多录一会儿，再按窗口的位置裁出来。 */
async function clip(name, act, tail = 900) {
  if (!record) { await act(); return; }
  const raw = join(work, `${name}.screen.mp4`);
  const file = join(work, `${name}.mp4`);
  const win = windowOnScreen();
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "60", "-draw_mouse", "1", "-i", "desktop",
    "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", raw], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  // 先挂上退出的监听：ffmpeg 提前退出时立刻报错，不干等。
  let exited = false;
  const done = new Promise((resolve) => ffmpeg.on("exit", (code) => { exited = true; resolve(code); }));
  await delay(700);
  if (exited) throw new Error(`ffmpeg exited before recording ${name}`);
  try { await act(); await delay(tail); } finally {
    if (!exited) { ffmpeg.stdin.write("q"); ffmpeg.stdin.end(); }
    const timer = setTimeout(() => ffmpeg.kill(), 5000);
    await done; clearTimeout(timer);
  }
  // 录到的画面宽 / 屏幕宽 = 两个坐标系的比例；裁出窗口（去掉 Windows 的不可见边框各 8 px 左右，按比例）。
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", raw], { encoding: "utf8" });
  const [vw, vh] = probe.stdout.trim().split(",").map(Number);
  const k = vw / win.sw;
  // 最大化的窗口带着各 8 px 的不可见边框，会越出画面：裁剪区域限制在画面以内。
  const x = Math.max(0, Math.round(win.l * k)), y = Math.max(0, Math.round(win.t * k));
  const w = Math.min(Math.round(win.r * k), vw) - x & ~1, h = Math.min(Math.round(win.b * k), vh) - y & ~1;
  console.log("record", name, JSON.stringify({ win, k, x, y, w, h }));
  const crop = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", `crop=${w}:${h}:${x}:${y}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", file], { stdio: "inherit" });
  // 整屏的原始录像里有屏幕上别的东西：裁完就删，只留窗口。
  rmSync(raw, { force: true });
  if (crop.status !== 0) throw new Error(`crop ${name} failed`);
  console.log("clip", name);
}

const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const settle = () => delay(900);
const closeToasts = () => until("notices closed", async () => {
  await session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;"); await delay(400);
  return session.exec("return !document.querySelector('.k-toast-close');");
});
/** 第 n 摞（墙上的顺序）的封面选择器；按张数找，免得依赖卡片 id。 */
const stack = (pages) => session.exec(`const count = [...document.querySelectorAll('.wall-canvas > .card-count')].find(b => b.textContent.trim() === String(arguments[0]));
  if (!count) return null; const id = count.dataset.card; return '.card[data-id="' + id + '"]';`, [pages]);
/** 从顶上往下滚，直到墙上挂载了这一摞（墙只挂载视口附近的卡片）。 */
async function seek(pages) {
  await session.exec("document.querySelector('.wall').scrollTop = 0; return true;"); await delay(300);
  for (let i = 0; i < 40; i++) {
    const found = await countButton(pages);
    if (found) return found;
    await session.exec("const wall = document.querySelector('.wall'); wall.scrollTop += wall.clientHeight * 0.6; return true;"); await delay(250);
  }
  throw new Error(`no stack of ${pages}`);
}
const countButton = (pages) => session.exec(`const count = [...document.querySelectorAll('.wall-canvas > .card-count')].find(b => b.textContent.trim() === String(arguments[0]));
  return count ? '.card-count[data-card="' + count.dataset.card + '"]' : null;`, [pages]);
/** 让这一摞停在视口上部三分之一处。 */
const reveal = (css) => session.exec(`const el = document.querySelector(arguments[0]); const wall = document.querySelector('.wall');
  wall.scrollTop += el.getBoundingClientRect().top - wall.getBoundingClientRect().top - wall.clientHeight / 4; return true;`, [css]);
const failures = [];
/** 一步失败只记下来，后面的照常截。 */
async function step(label, run) {
  try { await run(); } catch (error) { failures.push(`${label}: ${error.message}`); console.log("FAILED", label, error.message); try { await session.key(""); await session.key(""); } catch {} }
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ x: 0, y: 0, width: 1440, height: 900 });
  await until("empty wall", () => session.exec("return Boolean(document.querySelector('.wall-empty'));"));
  await session.invoke("start_import", { libraryId: info.id, source: { paths: [eagle] } });
  await until("stacks on the wall", () => session.exec("return document.querySelectorAll('.wall-canvas > .card-count').length >= 4;"), 60000);
  // Eagle 导入后先问标签的外部对应：直接完成。
  // 对话框有时在墙出现后才弹出：等它出现再点，点完确认它已关上。
  const clickDone = "const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '完成'); if (b) b.click(); return Boolean(b);";
  await until("tag mapping", () => session.exec(clickDone), 20000).catch(() => {});
  await until("tag mapping closed", () => session.exec("return ![...document.querySelectorAll('button')].some(x => x.textContent.trim() === '完成');"), 10000);
  await settle(); await closeToasts().catch(() => {}); await session.park(); await settle(); await settle();

  await step("wall at rest", () => session.shot("01-wall"));
  await step("hover a stack", async () => {
    await seek(6); const six = await stack(6); await reveal(six); await settle();
    await session.pointer(six); await delay(700);
    await session.shot("02-hover");
    await session.park(); await settle();
  });
  await step("select a stack", async () => {
    const six = await stack(6);
    await session.pointer(six, { click: true }); await session.park(); await settle();
    await session.shot("03-stack-selected");
  });
  await step("open the tray", async () => {
    await session.click(await countButton(6));
    await until("tray", () => session.exec("return Boolean(document.querySelector('.wall-tray'));"), 5000);
    await session.park(); await settle();
    await session.shot("04-tray-open");
  });
  await step("select pages in the tray", async () => {
    const pages = await session.exec("return [...document.querySelectorAll('.wall-canvas > .card.is-tray-page')].map(n => '.card[data-id=\"' + n.dataset.id + '\"]');");
    await session.pointer(pages[1], { click: true });
    await session.pointer(pages[3], { click: true, ctrl: true });
    await session.pointer(pages[4], { dx: 10, dy: 10 }); await delay(400);
    await session.shot("05-tray-pages-selected");
  });
  await step("close the tray with Esc", async () => {
    await session.key(""); await session.key("");
    await until("tray closed", () => session.exec("return !document.querySelector('.wall-tray');"), 5000);
    await session.park(); await settle();
  });
  await step("twelve-page tray", async () => {
    const twelve = await seek(12); await reveal(twelve); await settle();
    await session.click(twelve); await session.park(); await settle();
    await session.shot("06-tray-twelve-pages");
    await session.key(""); await settle();
  });
  await step("wall menu", async () => {
    // 墙左边的内边距里没有卡片：在那里右键是空白处的菜单。
    await session.exec("const wall = document.querySelector('.wall'); const r = wall.getBoundingClientRect(); wall.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + r.height / 2 })); return true;");
    await until("menu", () => session.exec("return Boolean([...document.querySelectorAll('[role=menuitemcheckbox]')].find(x => x.textContent.includes('叠放图集')));"), 5000);
    await settle(); await session.shot("07-wall-menu");
    await session.key(""); await settle();
  });

  // 录屏：日间、夜间各一段，依次是悬停拿起、打开托盘、点托盘下面的一格关上托盘。
  // WebDriver 改过尺寸的窗口里 WebView 可能比窗口大（右边被截掉）：录之前最大化，让系统排窗口。
  if (record) { await wd("POST", `${session.base}/window/maximize`, {}); await delay(1500); }
  for (const theme of ["light", "dark"]) {
    await step(`clip ${theme}`, async () => {
      await session.theme(theme);
      await seek(6); const six = await stack(6); await reveal(six); await session.park(); await settle();
      await clip(`clip-${theme === "light" ? "day" : "night"}`, async () => {
        await session.pointer(six); await delay(900);
        await session.park(); await delay(600);
        await session.click(await countButton(6)); await delay(1200);
        const below = await session.exec(`const tray = document.querySelector('.wall-tray').getBoundingClientRect();
          const node = [...document.querySelectorAll('.wall-canvas > .card:not(.is-tray-page)')].find(n => { const r = n.getBoundingClientRect(); return r.top > tray.bottom && r.bottom < innerHeight; });
          return node ? '.card[data-id="' + node.dataset.id + '"]' : null;`);
        if (below) await session.pointer(below, { click: true }); else await session.key("");
        await delay(400); await session.park();
      });
      await session.key(""); await settle();
    });
  }
  await session.theme("light");
  console.log(`Evidence: ${work}`);
} finally {
  if (failures.length) { console.log("Failed steps:"); for (const f of failures) console.log(" - " + f); }
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
