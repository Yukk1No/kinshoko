// #491：易用性审查文案改动的日间、夜间截图。新数据目录里依次截欢迎页、新建图库、空图库、导入结束的提示、
// 右键菜单、文件夹、编辑分组、管理图库、从 Eagle 导入、参考组，以及设置各页（含标签的各个子页）。
// 夜间用 :root[data-theme="dark"] 强制，与系统深色走同一套令牌。截图工具与 usability-review-470.mjs 相同。
// Usage: node e2e/copy-pass-491.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createDriver } from "./lib/driver.mjs";
import { chunk, gradientPng as png } from "./lib/fixtures.mjs";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/copy-pass-491.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4592;
const driverUrl = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

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
  async find(xpath, timeout) {
    return until("find " + xpath, async () => (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT], timeout);
  }
  async click(xpath) {
    const id = await this.find(xpath);
    await wd("POST", `${this.base}/element/${id}/click`, {});
  }
  async type(xpath, text) {
    const id = await this.find(xpath);
    await wd("POST", `${this.base}/element/${id}/value`, { text });
  }
  rect(rect) { return wd("POST", `${this.base}/window/rect`, rect); }
  /** 指针移到窗口左下角的空处。 */
  park() { return wd("POST", `${this.base}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 200, y: 880 }] }] }); }
  close() { return wd("DELETE", this.base); }
  async theme(name) { await this.exec("document.documentElement.dataset.theme = arguments[0]; return true;", [name]); await delay(500); }
  async capture(name, path) {
    for (const theme of ["light", "dark"]) {
      await this.theme(theme);
      writeFileSync(join(work, `${name}-${theme === "light" ? "day" : "night"}.png`), Buffer.from(await wd("GET", path()), "base64"));
    }
    await this.theme("light");
    console.log("shot", name);
  }
  /** 同一画面截日间、夜间两张，截完回到日间。 */
  shot(name) { return this.capture(name, () => `${this.base}/screenshot`); }
  /** 只截一个元素（日间、夜间）。 */
  async shotElement(css, name) {
    const id = (await wd("POST", `${this.base}/element`, { using: "css selector", value: css }))[ELEMENT];
    return this.capture(name, () => `${this.base}/element/${id}/screenshot`);
  }
}

const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
const palette = [[[233, 196, 106], [42, 157, 143]], [[244, 162, 97], [38, 70, 83]], [[231, 111, 81], [233, 196, 106]], [[131, 56, 236], [58, 134, 255]],
  [[255, 190, 11], [251, 86, 7]], [[6, 214, 160], [17, 138, 178]], [[38, 70, 83], [244, 162, 97]], [[58, 134, 255], [255, 190, 11]]];
const sizes = [[240, 320], [320, 240], [240, 240], [200, 340], [320, 200], [260, 300], [300, 220], [220, 300]];
const settle = () => delay(900);
const escape = () => session.exec("(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
const closeToasts = () => until("notices closed", async () => {
  await session.exec("document.querySelectorAll('.k-toast-close').forEach(b => b.click()); return true;"); await delay(400);
  return session.exec("return !document.querySelector('.k-toast-close');");
});
const card = (i) => session.exec("return [...document.querySelectorAll('.wall [data-id]')][arguments[0]].dataset.id;", [i]);
const pick = (id, ctrl) => session.exec("document.querySelector(`[data-id=\"${arguments[0]}\"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: arguments[1] })); return true;", [id, ctrl]);
const rightClick = (selector) => session.exec(`const el = document.querySelector(arguments[0]); const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true;`, [selector]);
const failures = [];
/** 一步失败只记下来，后面的照常截。 */
async function step(label, run) {
  try { await run(); } catch (error) { failures.push(`${label}: ${error.message}`); console.log("FAILED", label, error.message); try { await escape(); await escape(); } catch {} }
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("welcome", () => session.exec("return Boolean(document.querySelector('#welcome-title'));"));
  await settle(); await closeToasts().catch(() => {});
  // 欢迎页与新建图库：去掉了说明句，按钮叫“新建图库”。
  await step("welcome", () => session.shot("01-welcome"));
  await step("create library", async () => {
    await session.click("//button[@aria-labelledby='welcome-create']"); await settle();
    await session.shot("02-create-library");
  });
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.invoke("create_folder", { libraryId: info.id, name: "人物", parent: null });
  await session.invoke("create_folder", { libraryId: info.id, name: "配色", parent: null });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("empty wall", () => session.exec("return Boolean(document.querySelector('.wall-empty'));"));
  await settle(); await closeToasts().catch(() => {}); await settle();
  // 空图库：标签栏空着时写“还没有分组”。
  await step("empty library", () => session.shot("03-empty-library"));
  // 导入结束的提示：数字带“张”。
  await step("import notice", async () => {
    await session.invoke("start_import", { libraryId: info.id, source: { paths } });
    await until("import finished", () => session.exec("return [...document.querySelectorAll('.k-toast button')].some(b => b.textContent.includes('打开'));"), 30000);
    await settle(); await session.shot("04-import-done");
  });
  await closeToasts().catch(() => {});
  await step("wall", async () => {
    await until("wall", () => session.exec(`return document.querySelector('.wall')?.dataset.total === '${paths.length}';`)); await settle();
  });
  // 右键菜单：钉住局部、在资源管理器中显示。
  await step("card menu", async () => {
    await rightClick(`[data-id="${await card(0)}"]`); await settle();
    await session.shot("05-card-menu");
    await escape(); await settle();
  });
  // 文件夹：右键菜单（重命名）与空文件夹。
  await step("folder menu", async () => {
    await session.click("//button[@aria-label='展开示例参考']"); await settle();
    await rightClick("[aria-label^='人物（']"); await settle();
    await session.shot("06-folder-menu");
    await escape(); await settle();
  });
  await step("empty folder", async () => {
    await session.click("//button[starts-with(@aria-label, '配色（')]"); await settle();
    await session.shot("07-empty-folder");
    await session.click("//button[starts-with(@aria-label, '示例参考')]").catch(() => {}); await settle();
  });
  // 编辑分组、管理图库、从 Eagle 导入：说明句删了。
  await step("tag groups", async () => {
    await session.click("//button[contains(@class, 'groupbar-edit')]"); await settle();
    await session.shot("08-tag-groups");
    await escape(); await settle();
  });
  await step("manage libraries", async () => {
    await session.click("//button[@aria-label='打开、新建或管理图库']"); await settle();
    await session.click("//*[@role='menuitem' and contains(., '管理图库')]"); await settle();
    await session.shot("09-manage-libraries");
    await escape(); await settle();
  });
  await step("eagle import", async () => {
    await session.click("//button[contains(@class, 'k-import')]"); await settle();
    await session.click("//*[@role='menuitem' and contains(., '从 Eagle 导入')]");
    await until("eagle dialog", () => session.exec("return Boolean(document.querySelector('.k-import-dialog'));")); await settle();
    await session.shot("10-eagle-import");
    await escape(); await settle();
  });
  // 参考组与截图：空状态只留一句。
  await step("reference groups", async () => {
    await session.click("//nav[@class='rail']//button[@aria-label='参考组']"); await settle();
    await session.shot("11-reference-groups");
    await session.click("//nav[@class='rail']//button[@aria-label='截图']"); await settle();
    await session.shot("12-captures");
    await session.click("//nav[@class='rail']//button[@aria-label='图片与文件夹']"); await settle();
  });
  // 设置各页。
  await step("settings", async () => {
    await session.click("//nav[@class='rail']//button[@aria-label='设置']");
    await until("settings", () => session.exec("return Boolean(document.querySelector('.k-settings:not(.is-loading)'));")); await session.park(); await settle();
    await session.shot("13-settings-general");
    const tab = (name, file) => step(file, async () => { await session.click(`//*[@role='tab' and contains(., '${name}')]`); await session.park(); await settle(); await session.shot(file); });
    await tab("快捷键", "14-settings-keys");
    await tab("标签", "15-settings-tag-names");
    for (const [view, file] of [["分组", "16-settings-tag-groups"], ["相近", "17-settings-tag-approx"], ["对应", "18-settings-tag-mapping"], ["外观", "19-settings-tag-appearance"]]) {
      await step(file, async () => {
        await session.click(`//*[contains(@class, 'k-set-seg')]//button[contains(., '${view}')]`); await session.park(); await settle();
        await session.shot(file);
      });
    }
    await tab("自动标签", "20-settings-tagging");
    await tab("备份", "21-settings-backup");
    await tab("安全", "22-settings-safety");
    await tab("更新", "23-settings-update");
    await tab("诊断", "24-settings-diagnostics");
    await escape(); await settle();
  });
  console.log(`Evidence: ${work}`);
} finally {
  if (failures.length) { console.log("Failed steps:"); for (const f of failures) console.log(" - " + f); }
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
