// #470 #471 #472：易用性审查三个 PR 合在一起的日间、夜间截图。新数据目录里建空图库，
// 依次截空图库、自动标签停下的图标、导入结束的提示、查找无结果、图片墙与菜单、多选、设置各页。
// 夜间用 :root[data-theme="dark"] 强制，与系统深色走同一套令牌。
// Usage: node e2e/usability-review-470.mjs <kinshoko.exe> <matching msedgedriver.exe> <输出目录>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createDriver } from "./lib/driver.mjs";
import { chunk, gradientPng as png } from "./lib/fixtures.mjs";

const [, , appArg, edgeArg, outArg] = process.argv;
if (!appArg || !edgeArg || !outArg) throw new Error("Usage: node e2e/usability-review-470.mjs <kinshoko.exe> <msedgedriver.exe> <out>");
const application = resolve(appArg);
const work = resolve(outArg);
mkdirSync(work, { recursive: true });
const port = 4582;
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
  const paths = sizes.map(([w, h], i) => { const path = join(work, `ref-${i + 1}.png`); png(path, w, h, palette[i]); return path; });
  const parent = join(work, "libraries"); mkdirSync(parent, { recursive: true });
  const info = await session.invoke("create_library", { parent, name: "示例参考" });
  await session.close(); quitOwnApp(); await delay(800);

  session = await Session.start();
  await session.rect({ width: 1440, height: 900 });
  await until("empty wall", () => session.exec("return Boolean(document.querySelector('.wall-empty'));"));
  await settle(); await closeToasts(); await settle();

  // #470：空图库给“导入图片／导入文件夹”；右下角自动标签停下的图标（新数据目录没有模型）。
  await step("empty library", () => session.shot("01-empty-library"));
  await step("tagging icon", async () => {
    await until("tagging icon", () => session.exec("return Boolean(document.querySelector('.k-tagging-activity'));"), 8000);
    await session.shotElement(".k-tagging-activity", "02-tagging-stopped-icon");
    await session.click("//button[contains(@class, 'k-tagging-activity')]");
    await until("settings", () => session.exec("return Boolean(document.querySelector('.k-settings:not(.is-loading)'));")); await settle();
    await session.shot("03-tagging-icon-opens-settings");
    await escape(); await settle();
  });

  // #470：导入结束的提示带“打开”，点了跳到导入的位置。
  await step("import notice", async () => {
    await session.invoke("start_import", { libraryId: info.id, source: { paths } });
    await until("import finished", () => session.exec("return [...document.querySelectorAll('.k-toast button')].some(b => b.textContent.includes('打开'));"), 30000);
    await settle();
    await session.shot("04-import-done-open");
    await session.click("//*[contains(@class, 'k-toast')]//button[contains(., '打开')]");
    await until("wall", () => session.exec(`return document.querySelector('.wall')?.dataset.total === '${paths.length}';`)); await settle();
    await session.shot("05-after-open");
  });
  await closeToasts().catch(() => {});

  // #470：查找没有结果时给“清除条件”。
  await step("no results", async () => {
    await session.type("//input[@aria-label='查找参考图']", "zzzz"); await settle();
    await session.click("//*[@role='option' and contains(., '查找“zzzz”')]");
    await until("empty search", () => session.exec("return Boolean(document.querySelector('.wall-empty'));")); await settle();
    await session.shot("06-no-results");
    await session.click("//*[contains(@class, 'wall-empty')]//button[contains(., '清除条件')]");
    await until("wall back", () => session.exec(`return document.querySelector('.wall')?.dataset.total === '${paths.length}';`)); await settle();
  });

  // #471：图片墙、右键菜单、多选操作条、查看器、导入菜单。
  await step("wall", () => session.shot("07-wall"));
  await step("card menu", async () => {
    await rightClick(`[data-id="${await card(0)}"]`); await settle();
    await session.shot("08-card-menu");
    await escape(); await settle();
  });
  await step("multi select", async () => {
    await pick(await card(0), true); await pick(await card(1), true); await pick(await card(2), true);
    await until("selection bar", () => session.exec("return Boolean(document.querySelector('[role=toolbar][aria-label=已选参考图操作]'));"), 8000); await settle();
    await session.shot("09-multi-select");
    await escape(); await settle();
  });
  await step("viewer", async () => {
    const first = await card(0);
    await session.exec("const el = document.querySelector(`[data-id=\"${arguments[0]}\"]`); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;", [first]);
    await until("viewer", () => session.exec("return Boolean(document.querySelector('.viewer'));")); await settle();
    await session.shot("10-viewer");
    await session.click("//button[@aria-label='返回图片墙']"); await settle();
  });
  await step("import menu", async () => {
    await session.click("//button[contains(@class, 'k-import')]"); await settle();
    await session.shot("11-import-menu");
    await escape(); await settle();
  });

  // #471 #472：设置各页（自动标签页有模型大小与置信度，备份页有大小）。
  await step("settings", async () => {
    await session.click("//nav[@class='rail']//button[@aria-label='设置']");
    await until("settings", () => session.exec("return Boolean(document.querySelector('.k-settings:not(.is-loading)'));")); await settle();
    await session.shot("12-settings-general");
    for (const [name, file] of [["快捷键", "13-settings-keys"], ["标签", "14-settings-tags"], ["自动标签", "15-settings-tagging"], ["备份", "16-settings-backup"], ["安全", "17-settings-safety"], ["更新", "18-settings-update"], ["诊断", "19-settings-diagnostics"]]) {
      // 对话框随分页高度重新居中，点完把指针移开，免得停在别的分页上留下悬停底色。
      await step(file, async () => { await session.click(`//*[@role='tab' and contains(., '${name}')]`); await session.park(); await settle(); await session.shot(file); });
    }
    await escape(); await settle();
  });
  console.log(`Evidence: ${work}`);
} finally {
  if (failures.length) { console.log("Failed steps:"); for (const f of failures) console.log(" - " + f); }
  try { await session?.close(); } catch {}
  quitOwnApp();
  driver.kill();
}
