// #371：pixiv 收藏夹同步在真实应用里的关键页面（日间与夜间）：不设任何环境变量，订阅入口照常出现；添加菜单、
// 同步 pixiv 收藏夹对话框、名单上的「我的收藏夹」与它存进来的图、已经在同步时菜单里变灰、订阅设置、安全模式下 R-18 图不上屏，
// 以及设置里关掉订阅功能后入口消失。数据准备同 subscriptions-370.mjs：假账号、不到期的订阅，不访问 pixiv。
// 不点“开始同步”“保存”（会马上检查，请求 pixiv）。
// Usage: node e2e/subscriptions-371.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDriver } from "./lib/driver.mjs";
import { chunk, png } from "./lib/fixtures.mjs";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/subscriptions-371.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
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

const hover = async (xpath) => {
  const id = await until("find " + xpath, async () => (await wd("POST", `${session.base}/element`, { using: "xpath", value: xpath }))["element-6066-11e4-a52e-4f735466cecf"]);
  await wd("POST", `${session.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: { "element-6066-11e4-a52e-4f735466cecf": id }, x: 0, y: 0 }] }] });
};
/** 两种主题各截一张。 */
const both = async (name) => {
  await theme("light"); await settle(); await session.shot(`${name}-light.png`);
  await theme("dark"); await settle(); await session.shot(`${name}-dark.png`);
  await theme("light"); await settle();
};
const openAddMenu = async () => { await session.click("//aside//button[@aria-label='添加订阅']"); await settle(); };
const account = (expired) => writeFileSync(join(subsDir, "pixiv-account.json"),
  JSON.stringify({ refreshToken: "example-not-a-real-token", account: { userId: "9", name: "yuki_sub", explicitAllowed: true }, expired }));
const reopen = async () => {
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await openSubscriptions(); await delay(1500);
};
const BOOKMARKS = "//aside//button[contains(@class, 'subs-row') and contains(., '我的收藏夹')]";

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "参考图"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("plugin:library|create_library", { parent, name: "主图库" });
  await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths } });
  const browse = () => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const page = await until("import", async () => { const p = await browse(); return p.total === paths.length && p; });
  const imageIds = page.cards.map((card) => card.imageId ?? card.id);

  // 先让应用建好订阅记录，再写入示例：登录着的假账号，两位画师，都在 10 分钟前查过，不到期。
  await restart();
  await session.close(); quitOwnApp(); await delay(800);
  mkdirSync(subsDir, { recursive: true });
  account(false);
  const now = Date.now();
  let db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  const prepare = () => ({
    addSub: db.prepare("INSERT INTO subscription (id, source, target, name, library_id, include_explicit, include_manga, created_at, last_checked_at, backlog, since) VALUES (?, 'pixiv', ?, ?, ?, 1, ?, ?, ?, ?, ?)"),
    addWork: db.prepare("INSERT INTO received_work (library_id, source, work_id, subscription_id, outcome, explicit, received_at, seen) VALUES (?, 'pixiv', ?, ?, 'collected', ?, ?, ?)"),
    addPage: db.prepare("INSERT INTO received_page (library_id, source, work_id, page, image_id, received_at) VALUES (?, 'pixiv', ?, 0, ?, ?)"),
  });
  let { addSub, addWork, addPage } = prepare();
  const artists = () => [["s1", "1001", "Mika"], ["s2", "1002", "ぽち"]].forEach(([id, userId, name], i) =>
    addSub.run(id, JSON.stringify({ kind: "pixivArtist", userId }), name, info.id, 0, now - 86_400_000 + i, now - 10 * 60_000, JSON.stringify({ kind: "newOnly" }), now - 86_400_000));
  artists();
  const receive = (owners, explicit = []) => imageIds.forEach((imageId, i) => {
    const at = now - i * 3_600_000;
    addWork.run(info.id, `w${i}`, owners[i], explicit.includes(i) ? 1 : 0, at, i < 4 ? 0 : 1);
    addPage.run(info.id, `w${i}`, imageId, at);
  });
  receive(["s1", "s1", "s2", "s1", "s2", "s2", "s1", "s2", "s1", "s1", "s1", "s2"]);
  db.close();

  await reopen();
  // 新装时安全模式开着：先关掉。
  await toggleSafe();

  // A 添加菜单：画师、榜单、pixiv 收藏夹都能选。
  await openAddMenu();
  await both("A1-add-menu");
  // 同步 pixiv 收藏夹：默认两边都不同步已有的收藏、不同步漫画、同步 R-18、存进当前图库。
  await session.click("//*[@role='menuitem' and contains(., 'pixiv 收藏夹')]"); await settle();
  await both("A2-bookmarks-dialog");
  // 公开收藏改成最近 50 张，非公开收藏全部同步，不同步 R-18。
  await session.exec("const input = document.querySelector(\"[role='dialog'] input[inputmode='numeric']\"); input.focus(); return true;");
  await wd("POST", `${session.base}/actions`, { actions: [{ type: "key", id: "keys", actions: [{ type: "keyDown", value: "" }, { type: "keyUp", value: "" }, { type: "keyDown", value: "" }, { type: "keyUp", value: "" }, { type: "keyDown", value: "5" }, { type: "keyUp", value: "5" }, { type: "keyDown", value: "0" }, { type: "keyUp", value: "0" }] }] });
  await session.click("//*[@role='dialog']//*[@role='radiogroup' and @aria-label='已有的非公开收藏']//label[contains(., '全部')]"); await settle();
  await session.click("//*[@role='dialog']//*[@role='switch' and @aria-label='R-18 作品']"); await settle();
  await both("A3-bookmarks-recent");
  await escape(); await settle();

  // 写入收藏夹订阅：存进来的图里有 R-18 的。
  await session.close(); quitOwnApp(); await delay(800);
  db = new DatabaseSync(join(subsDir, "subscriptions.db"));
  ({ addSub, addWork, addPage } = prepare());
  db.exec("DELETE FROM received_page; DELETE FROM received_work;");
  addSub.run("b1", JSON.stringify({ kind: "pixivBookmarks" }), "", info.id, 1, now - 3_600_000, now - 10 * 60_000, JSON.stringify({ kind: "newOnly" }), null);
  // 作品 0、3、6 是收藏夹收的 R-18 图。
  receive(["b1", "b1", "s1", "b1", "s2", "b1", "b1", "s2", "b1", "s1", "b1", "b1"], [0, 3, 6]);
  db.close();
  await reopen();

  // B 名单：画师下面是 pixiv 收藏夹 › 我的收藏夹；选中它看存进来的图。
  await both("B1-list");
  await session.click(BOOKMARKS); await park(); await settle();
  await both("B2-bookmarks-selected");

  // C 已经在同步：添加菜单里「pixiv 收藏夹」变灰。
  await openAddMenu();
  await both("C-add-menu-syncing");
  await escape(); await settle();

  // D 收藏夹的订阅设置：漫画与 R-18。
  await hover(BOOKMARKS); await settle();
  await session.click("//aside//div[contains(@class, 'subs-row-wrap') and .//button[contains(., '我的收藏夹')]]//button[@aria-label='更多']"); await settle();
  await session.click("//*[@role='menuitem' and contains(., '订阅设置')]"); await settle();
  await both("D-settings");
  await session.click("//*[@role='dialog']//button[contains(., '取消')]"); await settle();

  // E 安全模式开着：收藏夹收的 R-18 图不上屏。
  await session.click(BOOKMARKS); await park(); await settle();
  await toggleSafe();
  await both("E-safe-mode");
  await toggleSafe();

  // F 设置里关掉订阅功能：入口消失，不再检查；再打开入口回来。
  await session.invoke("set_subscriptions_enabled", { on: false }); await settle(); await park();
  await both("F1-switched-off");
  await session.invoke("set_subscriptions_enabled", { on: true }); await settle();
  await both("F2-switched-on");
  console.log(`Evidence: ${work}`);
} finally {
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
