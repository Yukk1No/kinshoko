// #426：保存位置预填与“窗口不持有资料库”的真机核对（日间与夜间）。拖放经 Tauri 事件通道发出，不是鼠标真的拖动。
// 依次核对：拖入提示与导入对话框的预填；打开和新建图库后选择、导入结果还在，旧名称提示跟着登记刷新；
// 回收站里导入禁用、拖入只发通知；A 库导入中整理 B 库文件夹（ADR-0008）。
// Usage: node e2e/save-destination-430.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chunk, oldLibrary } from "./legacy-tag-names.helpers.mjs";
import { createDriver } from "./lib/driver.mjs";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/save-destination-430.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4612;
const driverUrl = `http://127.0.0.1:${port}`;

// 例外（#521）：这张图的尺寸、颜色规则与 lib/fixtures.mjs 的 png 不同，合并会改变测试图的像素，所以留在本地。
function png(path, width, height, seed) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const a = [(seed * 67) % 200 + 40, (seed * 131) % 200 + 40, (seed * 29) % 200 + 40];
  const b = [(seed * 17) % 200 + 40, (seed * 53) % 200 + 40, (seed * 97) % 200 + 40];
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(a[c] * (1 - t) + b[c] * t);
    }
    rows.push(row);
  }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]));
  return path;
}

const { wd, until, quitOwnApp } = createDriver({ driverUrl, application });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
function check(ok, label) { results.push({ ok: Boolean(ok), label }); console.log(`${ok ? "PASS" : "FAIL"} ${label}`); }
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
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const settle = () => delay(700);
const theme = (name) => session.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]);
const text = () => session.exec("return document.body.innerText;");
const has = async (needle) => (await text()).includes(needle);
const escape = () => session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
const closeToasts = () => session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;");
const drag = (kind, paths) => session.invoke("plugin:event|emit", { event: `tauri://drag-${kind}`, payload: kind === "leave" ? null : { paths, position: { x: 400, y: 400 } } });
const dropHint = () => session.exec("return document.querySelector('.k-drop-hint-icon')?.getAttribute('aria-label') ?? null;");
const scope = (prefix) => session.click(`//button[starts-with(@aria-label, '${prefix}') or starts-with(normalize-space(), '${prefix}')]`);
const twoSelected = () => session.exec("return (document.querySelector('[role=toolbar][aria-label=已选参考图操作]')?.innerText ?? '').includes('2 张');");
const selectTwo = async () => {
  await until("two cards", () => session.exec("return document.querySelectorAll('.card[data-id]').length >= 2;"));
  await session.exec("const [a] = document.querySelectorAll('.card[data-id]'); a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); return true;");
  await delay(400);
  await session.exec("const [, b] = document.querySelectorAll('.card[data-id]'); b.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); return true;");
  await until("two selected", twoSelected);
};
const resultCard = () => session.exec("return Boolean(document.querySelector('section[aria-label=导入结果]'));");
const progressCard = () => session.exec("return document.querySelector('section[aria-label=导入进度] .k-task-count')?.textContent ?? null;");
const dialogOpen = () => session.exec("return document.querySelector('.k-import-dialog .k-dialog-title')?.textContent === '导入图片';");
const dialogText = () => session.exec("return document.querySelector('.k-import-dialog')?.innerText ?? null;");

try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));

  // 数据：两个新库，一个 v16 旧库（打开后才有旧名称待确认），一批导入中用的大图。
  const files = join(work, "files"); mkdirSync(files, { recursive: true });
  const refs = Array.from({ length: 12 }, (_, i) => png(join(files, `ref-${i}.png`), 240 + i * 8, 320 - i * 6, i + 1));
  const bad = join(files, "坏文件.png"); writeFileSync(bad, Buffer.from("not an image"));
  const batch = Array.from({ length: 40 }, (_, i) => png(join(files, `batch-${i}.png`), 1400, 1400, i + 100));
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const browse = (libraryId, inner = { kind: "all" }) => session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "library", libraryId, scope: inner }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const load = async (name, paths) => {
    const info = await session.invoke("plugin:library|create_library", { parent, name });
    await session.invoke("plugin:library|start_import", { libraryId: info.id, source: { paths } });
    await until("import " + name, async () => (await browse(info.id)).total === paths.length);
    return info;
  };
  const a = await load("角色参考", refs.slice(0, 6));
  const b = await load("风景素材", refs.slice(6));
  const folderB = await session.invoke("plugin:library|create_folder", { libraryId: b.id, name: "晨雾", parent: null });
  const smallPng = png(join(files, "small.png"), 3, 3, 7);
  const oldSchema = readFileSync("crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql", "utf8");
  const firstOld = oldLibrary({ libraries: parent, imagePath: smallPng, oldSchema }, "旧名称第一库", "分发");
  await session.close(); quitOwnApp(); await delay(800);
  session = await Session.start();
  await until("main window", () => session.exec("return Boolean(document.querySelector('.rail'));"));
  await settle(); await closeToasts();
  await until("all scope wall", () => session.exec("return document.querySelectorAll('.card[data-id]').length >= 2;"));
  // 等启动的展开动画走完。
  await delay(3000);

  // 拖入提示：全部图片下预填登记最早的库。
  for (const name of ["light", "dark"]) {
    await theme(name);
    await drag("enter", [refs[0]]);
    const hint = await until("drop hint", dropHint);
    if (name === "light") {
      check(hint === "松开即可导入到 角色参考", `全部图片下拖入提示写登记最早的库：${hint}`);
      check((await session.exec("return document.querySelector('.k-drop-hint').innerText;")).trim() === "", "拖入提示只有图标，没有可见文字");
    }
    await settle(); await session.shot(`1-drop-hint-${name}.png`);
    await drag("leave");
    await until("hint gone", async () => (await dropHint()) === null);
  }

  // 导入对话框的预填。
  for (const name of ["light", "dark"]) {
    await theme(name);
    await drag("drop", [refs[0]]);
    await until("import dialog", () => dialogOpen());
    await settle();
    if (name === "light") { const dialog = await dialogText(); check(/角色参考/.test(dialog) && /未归类/.test(dialog), `全部图片下导入对话框预填角色参考 / 未归类：${dialog?.replace(/\s+/g, " ").slice(0, 80)}`); }
    await session.shot(`2-import-dialog-${name}.png`);
    await escape();
    await until("dialog closed", () => dialogOpen().then((open) => !open));
  }
  await theme("light");

  // 导入一个坏文件留下结果卡，再选两张，然后打开、新建图库。
  await drag("drop", [bad]);
  await until("import dialog", () => dialogOpen());
  await session.click("//*[@role='dialog']//button[normalize-space()='开始导入']");
  await session.click("//button[normalize-space()='查看']");
  await until("result card", resultCard);
  const rejected = "//section[@aria-label='导入结果']//button[@aria-expanded]";
  const expanded = () => session.exec("return document.querySelector('section[aria-label=导入结果] button[aria-expanded]')?.getAttribute('aria-expanded') ?? null;");
  check(await expanded() === "false" && !(await has("坏文件.png")) && await has("未导入") && !(await has("没导入")), "结果卡默认折叠，文案是未导入");
  for (const name of ["light", "dark"]) {
    await theme(name);
    await settle(); await session.shot(`5-result-collapsed-${name}.png`);
    await session.click(rejected);
    await until("expanded", async () => await expanded() === "true");
    if (name === "light") check(await has("坏文件.png"), "点开未导入这一行后列出文件");
    await settle(); await session.shot(`6-result-expanded-${name}.png`);
    await session.click(rejected);
    await until("collapsed", async () => await expanded() === "false");
  }
  await theme("light");
  await scope("角色参考");
  await until("library A wall", async () => (await session.exec("return document.querySelectorAll('.card[data-id]').length;")) === 6);
  await selectTwo();
  const noticeBefore = await session.exec("return document.body.innerText.match(/(\\d+) 个旧名称待确认/)?.[1] ?? null;");

  await session.exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]; return true;", [firstOld.info.root]);
  await session.click("//button[@aria-label='打开、新建或管理图库']");
  await session.click("//*[@role='menuitem'][contains(normalize-space(), '打开图库')]");
  await until("opened library in sidebar", () => has("旧名称第一库"));
  await settle();
  check(await twoSelected(), "打开图库后选择还在（已选 2 张）");
  check(await resultCard(), "打开图库后导入结果卡还在");

  await session.exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]]; return true;", [parent]);
  await session.click("//button[@aria-label='打开、新建或管理图库']");
  await session.click("//*[@role='menuitem'][contains(normalize-space(), '新建图库')]");
  await until("create form", () => session.exec("return Boolean(document.querySelector('.create-library-dialog'));"));
  await session.click("//button[normalize-space()='选择存放位置…']");
  await until("parent chosen", async () => !(await has("尚未选择")));
  await session.click("//button[normalize-space()='新建图库']");
  await until("back on wall", () => session.exec("return !document.querySelector('.create-library-dialog') && Boolean(document.querySelector('.rail'));"));
  await until("new library in sidebar", () => has("我的参考"));
  await settle();
  check(await twoSelected(), "新建图库后选择还在（已选 2 张）");
  check(await resultCard(), "新建图库后导入结果卡还在");
  const noticeAfter = await until("legacy notice", () => session.exec("return document.body.innerText.match(/(\\d+) 个旧名称待确认/)?.[1] ?? null;"));
  check(noticeBefore === null && noticeAfter === "1", `旧名称提示跟着登记刷新：打开前 ${noticeBefore ?? "无"}，打开后 ${noticeAfter}`);
  for (const name of ["light", "dark"]) { await theme(name); await settle(); await session.shot(`3-retained-with-legacy-notice-${name}.png`); }
  await theme("light");

  // 回收站：导入菜单禁用，拖入只发通知。
  await scope("回收站");
  await settle();
  for (const name of ["light", "dark"]) {
    await theme(name);
    await drag("enter", [refs[0]]);
    await delay(200);
    if (name === "light") check((await dropHint()) === null, "回收站里拖入不提示");
    await drag("drop", [refs[0]]);
    await until("trash notice", () => has("回收站内无法导入"));
    if (name === "light") check(!(await dialogOpen()), "回收站里松开后不弹导入对话框");
    await session.click("//button[@aria-label='导入']");
    const states = await until("import menu", () => session.exec("const items = [...document.querySelectorAll('[role=menuitem]')].filter((node) => /^(图片|文件夹|从 Eagle 导入)/.test(node.textContent.trim())); return items.length === 3 ? items.map((node) => node.hasAttribute('data-disabled') || node.getAttribute('aria-disabled') === 'true') : null;"));
    if (name === "light") check(states.every(Boolean), "回收站里导入菜单的图片、文件夹、Eagle 都禁用");
    await delay(300);
    await session.shot(`4-trash-menu-and-notice-${name}.png`);
    await escape();
    await delay(300);
    await closeToasts();
    await delay(300);
  }
  await theme("light");

  // ADR-0008：A 库导入中整理 B 库文件夹。
  await scope("全部图片");
  await until("all scope wall", () => session.exec("return document.querySelectorAll('.card[data-id]').length >= 12;"));
  await settle();
  await drag("drop", batch);
  await until("import dialog", () => dialogOpen());
  const batchDialog = await dialogText();
  check(/角色参考/.test(batchDialog), "大批导入预填角色参考");
  await session.click("//*[@role='dialog']//button[normalize-space()='开始导入']");
  const progressStart = await until("progress card", progressCard);
  await scope("风景素材");
  await until("library B wall", async () => (await session.exec("return document.querySelectorAll('.card[data-id]').length;")) === 6);
  await selectTwo();
  const progressBeforeMove = await progressCard();
  await session.click("//*[@role='toolbar'][@aria-label='已选参考图操作']//button[@aria-label='移到文件夹' or normalize-space()='移到文件夹']");
  await session.click("//*[@role='menuitem'][contains(normalize-space(), '晨雾')]");
  const moved = await until("two images in B's folder", async () => {
    const page = await session.invoke("plugin:library|workspace_browse", { query: { scope: { kind: "library", libraryId: b.id, scope: { kind: "folder", id: folderB } }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
    return page.total === 2 && page;
  }, 120000);
  const progressAfterMove = await progressCard();
  const importedAtMove = (await browse(a.id)).total;
  check(progressBeforeMove !== null && progressAfterMove !== null && importedAtMove < 46, `移动时 A 库导入还在进行（${progressStart} → ${progressBeforeMove} → ${progressAfterMove}，A 库此时 ${importedAtMove} 张）`);
  check(moved.total === 2, "B 库的文件夹里进了 2 张");
  check(await twoSelected(), "整理后 B 库的选择还在");
  check((await session.exec("return document.querySelectorAll('.card[data-id]').length;")) >= 2, "整理后仍在 B 库范围");
  const samples = [];
  await until("A finished", async () => {
    const value = await progressCard();
    if (value !== samples.at(-1)) samples.push(value);
    return (await browse(a.id)).total === 46;
  }, 300000);
  console.log("progress samples:", samples.join(", "));
  check(samples.some((value) => value && !value.startsWith("0 /")), `移到 B 库文件夹后 A 的进度继续走：${samples.slice(0, 4).join("，")} … ${samples.at(-1)}`);
  check(true, "A 库导入完成，共 46 张");
  check((await browse(b.id)).total === 6, "B 库图片数不变");
  writeFileSync(join(work, "checks.json"), JSON.stringify(results, null, 2));
  console.log(`Evidence: ${work}`);
  console.log(`PASS ${results.filter((r) => r.ok).length} / FAIL ${results.filter((r) => !r.ok).length}`);
} catch (error) {
  console.error(String(error));
  try { await session.shot("failure.png"); writeFileSync(join(work, "failure.txt"), await text()); } catch {}
  process.exitCode = 1;
} finally {
  writeFileSync(join(work, "checks.json"), JSON.stringify(results, null, 2));
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
