// Tauri WebDriver 冒烟测试（#44）：建库 → 导入文件夹 → 浏览 → 关闭后重开。
//
// 用法：node e2e/smoke.mjs <kinshoko.exe> [msedgedriver.exe]
// 需要 PATH 中有 tauri-driver（cargo install tauri-driver --locked），以及与 WebView2 版本一致的
// msedgedriver。直接说 W3C WebDriver 协议，不引入 WebdriverIO 等依赖。
// 原生文件对话框无法由 WebDriver 操作，测试把要“选中”的路径放进 window.__KINSHOKO_TEST_PICKS__。

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeDriverArg] = process.argv;
if (!appArg) {
  console.error("用法：node e2e/smoke.mjs <kinshoko.exe> [msedgedriver.exe]");
  process.exit(2);
}
const application = resolve(appArg);
const DRIVER = "http://127.0.0.1:4444";

// ---------- 样本 ----------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 单色 RGB PNG。 */
function png(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([r, g, b]).flat())]);
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const work = mkdtempSync(join(tmpdir(), "kinshoko-smoke-"));
const dataDir = join(work, "app-data");
const libraryParent = join(work, "libraries");
const source = join(work, "参考");
mkdirSync(libraryParent, { recursive: true });
mkdirSync(join(source, "人物"), { recursive: true });
writeFileSync(join(source, "横图.png"), png(300, 150, [200, 80, 80]));
writeFileSync(join(source, "人物", "竖图.png"), png(100, 300, [80, 160, 200]));
writeFileSync(join(source, "人物", "方图.png"), png(200, 200, [90, 200, 120]));
writeFileSync(join(source, "说明.txt"), "不是图片");

// ---------- WebDriver ----------

async function wd(method, path, body) {
  const res = await fetch(DRIVER + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${what}${last ? `（${last.message}）` : ""}`);
}

const ELEMENT = "element-6066-11e4-a52e-4f735466cecc";

class Session {
  static async start() {
    const value = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    return new Session(value.sessionId);
  }
  constructor(id) {
    this.base = `/session/${id}`;
  }
  exec(script, args = []) {
    return wd("POST", `${this.base}/execute/sync`, { script, args });
  }
  async find(xpath) {
    const v = await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath });
    return v[ELEMENT];
  }
  waitFor(what, xpath, timeout) {
    return until(what, () => this.find(xpath), timeout);
  }
  click(el) {
    return wd("POST", `${this.base}/element/${el}/click`, {});
  }
  async type(el, text) {
    await wd("POST", `${this.base}/element/${el}/clear`, {});
    await wd("POST", `${this.base}/element/${el}/value`, { text });
  }
  pick(value) {
    return this.exec("window.__KINSHOKO_TEST_PICKS__ = [arguments[0]];", [value]);
  }
  /** 图片墙上已挂载的卡片 id，以及缩略图是否都已解码。 */
  wall() {
    return this.exec(`
      const cards = [...document.querySelectorAll('.card[data-id]')];
      return {
        ids: cards.map((c) => c.dataset.id),
        ratios: cards.map((c) => c.offsetHeight / c.offsetWidth),
        loaded: cards.every((c) => { const i = c.querySelector('img'); return i.complete && i.naturalWidth > 0; }),
      };`);
  }
  close() {
    return wd("DELETE", this.base);
  }
}

/** 结束被测应用的进程，并等它真正退出。 */
async function quitApp() {
  const image = basename(application);
  spawnSync("taskkill", ["/F", "/T", "/IM", image], { stdio: "ignore" });
  await until("应用进程退出", () => {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], { encoding: "utf8" });
    return !out.stdout.toLowerCase().includes(image.toLowerCase());
  });
}

const button = (name) => `//button[normalize-space()='${name}']`;

function assert(ok, message) {
  if (!ok) throw new Error(`断言失败：${message}`);
  console.log(`✓ ${message}`);
}

const driverArgs = edgeDriverArg ? ["--native-driver", resolve(edgeDriverArg)] : [];
const driver = spawn("tauri-driver", driverArgs, {
  env: { ...process.env, KINSHOKO_DATA_DIR: dataDir, KINSHOKO_SKIP_AUTOSTART: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

let session;
try {
  await until("tauri-driver 就绪", () => fetch(`${DRIVER}/status`).then((r) => r.ok));

  // 建库
  session = await Session.start();
  await session.waitFor("建库引导", button("建立资料库"));
  await session.type(await session.find("//label[contains(., '资料库名称')]/input"), "冒烟测试库");
  await session.pick(libraryParent);
  await session.click(await session.find(button("选择存放位置…")));
  await session.waitFor("显示所选位置", `//*[normalize-space()='${libraryParent}']`);
  await session.click(await session.find(button("建立资料库")));
  await session.waitFor("打开新资料库", "//h1[normalize-space()='冒烟测试库']");
  assert(true, "建立资料库并打开");

  // 导入文件夹（含子文件夹）
  await session.pick(source);
  await session.click(await session.find(button("导入文件夹…")));
  await session.waitFor("导入完成", "//*[contains(normalize-space(), '导入完成：新增 3 张')]", 60000);
  await session.find(`//li[contains(., '说明.txt') and contains(., '不支持的格式')]`);
  assert(true, "导入 3 张图，不支持的文件逐个列出");

  // 浏览
  const before = await until("缩略图显示", async () => {
    const w = await session.wall();
    return w.ids.length === 3 && w.loaded ? w : null;
  });
  const sorted = [...before.ratios].sort((a, b) => a - b);
  assert(
    [0.5, 1, 3].every((r, i) => Math.abs(sorted[i] - r) < 0.05),
    `瀑布流按原比例显示（${sorted.map((r) => r.toFixed(2)).join("、")}）`,
  );

  // 关闭后重开。应用常驻托盘（#61），关掉窗口进程仍在，单实例插件会把新启动交给它；
  // 所以结束进程本身，等同“退出”后再启动。
  await session.close();
  session = null;
  await quitApp();
  session = await Session.start();
  await session.waitFor("重开后打开上次的资料库", "//h1[normalize-space()='冒烟测试库']");
  const after = await until("重开后的缩略图", async () => {
    const w = await session.wall();
    return w.ids.length === 3 && w.loaded ? w : null;
  });
  assert(JSON.stringify(after.ids) === JSON.stringify(before.ids), "重开后资料库与图片墙原样恢复");
  await session.close();
  session = null;
  console.log("冒烟测试通过");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  await quitApp().catch(() => {});
  driver.kill();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
