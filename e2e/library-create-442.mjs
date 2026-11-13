// #442：新建图库改为对话框、订阅里就地新建图库，在真实应用里的关键页面（日间与夜间）：
// 首次使用的整页建库引导（与原来一致）、已有图库时从图库切换器新建、订阅画师时叠着新建图库、第一次订榜单的「新建图库」卡片。
// 数据准备同 subscriptions-370.mjs：假账号、不到期的订阅，不访问 pixiv。不点“新建图库”“订阅”。
// Usage: node e2e/library-create-442.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
// Usage: node e2e/library-create-442.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDriver } from "./lib/driver.mjs";
import { png } from "./lib/fixtures.mjs";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/library-create-442.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
const data = join(work, "app-data");
const subsDir = join(data, "subscriptions");
mkdirSync(work, { recursive: true });
const port = 4598;
const driverUrl = `http://127.0.0.1:${port}`;

const { wd, until, quitOwnApp } = createDriver({ driverUrl, application });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
class Session {
  static async start() {
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
    const session = new Session(result.sessionId);
    await until("Tauri IPC ready", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
    await session.rect({ width: 1440, height: 900 });
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: JSON.stringify(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async click(xpath) {
    const id = await until("find " + xpath, async () => (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))["element-6066-11e4-a52e-4f735466cecf"]);
    await wd("POST", `${this.base}/element/${id}/click`, {});
  }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  close() { return wd("DELETE", this.base); }
  async shot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); console.log("shot", name); }
}

const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const settle = () => delay(900);
const theme = (name) => session.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]);
const escape = () => session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
const closeToasts = () => session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;");
const toggleSafe = async () => { await session.exec("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true })); return true;"); await delay(1500); };
/** 把鼠标移到主区空白处，图标轨的提示不挡画面。 */
const park = () => wd("POST", `${session.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 900, y: 860 }] }] });
const openSubscriptions = async () => {
  await session.click("//nav//button[@aria-label='订阅']");
  await session.exec("document.activeElement?.blur(); return true;"); await park(); await settle(); await closeToasts();
};
async function restart() {
  await session.close(); quitOwnApp(); await delay(800);
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
}

const palette = [[[233, 196, 106], [42, 157, 143]], [[244, 162, 97], [38, 70, 83]], [[231, 111, 81], [233, 196, 106]], [[131, 56, 236], [58, 134, 255]],
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]], [[239, 71, 111], [255, 209, 102]], [[118, 120, 237], [247, 184, 1]],
  [[140, 179, 105], [244, 226, 133]], [[93, 46, 140], [204, 102, 218]], [[46, 196, 182], [203, 243, 240]], [[255, 159, 28], [255, 191, 105]]];
const sizes = [[240, 330], [320, 230], [250, 250], [220, 360], [320, 210], [260, 300], [240, 280], [300, 240], [230, 340], [280, 260], [250, 320], [310, 220]];

/** 两种主题各截一张。 */
const both = async (name) => {
  await theme("light"); await settle(); await session.shot(`${name}-light.png`);
  await theme("dark"); await settle(); await session.shot(`${name}-dark.png`);
  await theme("light"); await settle();
};
const openRankingDialog = async () => {
  await session.click("//aside//button[@aria-label='添加订阅']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '榜单')]"); await settle();
};
const account = (expired) => writeFileSync(join(subsDir, "pixiv-account.json"),
  JSON.stringify({ refreshToken: "example-not-a-real-token", account: { userId: "9", name: "yuki_sub", explicitAllowed: true }, expired }));
const dialog = "//*[@role='dialog']";

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));

  // A 首次使用：整页建库引导，与原来一致。
  await session.click("//button[@aria-labelledby='welcome-create']"); await settle();
  await both("A-first-run-create");

  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "参考图"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("plugin:library|create_library", { parent, name: "主图库" });
  await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths } });
  const browse = () => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  await until("import", async () => (await browse()).total === paths.length);

  // 先让应用建好订阅记录，再写入示例：登录着的假账号，一位画师，10 分钟前查过，不到期。
  await restart();
  await session.close(); quitOwnApp(); await delay(800);
  mkdirSync(subsDir, { recursive: true });
  account(false);
  const now = Date.now();
  const db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  db.prepare("INSERT INTO subscription (id, source, target, name, library_id, include_explicit, include_manga, created_at, last_checked_at, backlog, since) VALUES (?, 'pixiv', ?, ?, ?, 1, 0, ?, ?, ?, ?)")
    .run("s1", JSON.stringify({ kind: "pixivArtist", userId: "1001" }), "Mika", info.id, now - 86_400_000, now - 10 * 60_000, JSON.stringify({ kind: "newOnly" }), now - 86_400_000);
  db.close();
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  // 新装时安全模式开着：先关掉，好看见图片墙。
  await toggleSafe(); await park(); await settle();

  // B 已有图库时从图库切换器新建：对话框叠在图片墙上。
  await session.click("//button[@aria-label='打开、新建或管理图库']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '新建图库')]"); await settle();
  await both("B-picker-create-dialog");
  await escape(); await settle();

  // C 订阅画师：图库下拉最后一项「新建图库…」，选它叠一层新建图库对话框。
  await openSubscriptions(); await delay(1500);
  await session.click("//aside//button[@aria-label='添加订阅']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '画师')]"); await settle();
  await session.click(`${dialog}//*[@role='combobox' and @aria-label='图库']`); await settle();
  await both("C1-artist-library-options");
  await session.click("//*[@role='option' and contains(., '新建图库')]"); await settle();
  await both("C2-artist-create-dialog");
  await escape(); await settle(); await escape(); await settle();

  // D 第一次订榜单：「新建图库」卡片用同一套表单，默认名「pixiv 榜单」。
  await session.click("//aside//button[@aria-label='添加订阅']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '榜单')]"); await settle();
  await both("D-ranking-first");
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
