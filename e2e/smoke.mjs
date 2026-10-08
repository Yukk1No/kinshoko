// Tauri WebDriver 冒烟测试（#44）：建库 → 导入文件夹 → 浏览 → 关闭后重开。
//
// 用法：node e2e/smoke.mjs <kinshoko.exe> [msedgedriver.exe] [tauri-driver.exe]
// 需要 PATH 中有 tauri-driver（cargo install tauri-driver --locked），以及与 WebView2 版本一致的
// msedgedriver。直接说 W3C WebDriver 协议，不引入 WebdriverIO 等依赖。
// 原生文件对话框无法由 WebDriver 操作，测试把要“选中”的路径放进 window.__KINSHOKO_TEST_PICKS__。

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeDriverArg] = process.argv;
if (!appArg) {
  console.error("用法：node e2e/smoke.mjs <kinshoko.exe> [msedgedriver.exe] [tauri-driver.exe]");
  process.exit(2);
}
const application = resolve(appArg);
const port = Number(process.env.KINSHOKO_SMOKE_PORT ?? 4444);
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("冒烟端口无效");
const DRIVER = `http://127.0.0.1:${port}`;

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

const evidenceRoot = resolve(process.env.KINSHOKO_SMOKE_WORK_ROOT ?? tmpdir());
mkdirSync(evidenceRoot, { recursive: true });
const work = mkdtempSync(join(evidenceRoot, "kinshoko-smoke-"));
const dataDir = join(work, "app-data");
const libraryParent = join(work, "libraries");
const source = join(work, "参考");
mkdirSync(libraryParent, { recursive: true });
console.log(`冒烟证据：${work}`);
const result = {
  source: process.env.GITHUB_SHA ?? process.env.KINSHOKO_SMOKE_SOURCE ?? null,
  application,
  binarySha256: createHash("sha256").update(readFileSync(application)).digest("hex"),
  harnessSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
  startedAt: new Date().toISOString(), assertions: [],
};
mkdirSync(join(source, "人物"), { recursive: true });
writeFileSync(join(source, "横图.png"), png(300, 150, [200, 80, 80]));
// 竖图取 1:2：图片墙把高宽比超过 2.6 的长图整体缩小（src/wall/Wall.tsx 的 CAP_RATIO），
// 这里只验证按原比例显示。
writeFileSync(join(source, "人物", "竖图.png"), png(100, 200, [80, 160, 200]));
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

// W3C WebDriver 规定的元素引用键（§12.1 web element identifier）。
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

class Session {
  static async start() {
    try {
      const value = await wd("POST", "/session", {
        capabilities: { alwaysMatch: { "tauri:options": { application } } },
      });
      return new Session(value.sessionId);
    } catch (e) {
      reportProcesses();
      throw e;
    }
  }
  constructor(id) {
    this.base = `/session/${id}`;
  }
  exec(script, args = []) {
    return wd("POST", `${this.base}/execute/sync`, { script, args });
  }
  async find(xpath) {
    const v = await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath });
    // 找到了却取不出引用时直接报错，不当作“还没出现”一直等到超时。
    if (!v?.[ELEMENT]) throw new Error(`元素引用格式不对：${JSON.stringify(v)}`);
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
  currentLibrary(name) {
    return this.exec(`
      const select = document.querySelector('select[aria-label="当前资料库"]');
      const option = select?.selectedOptions[0];
      return select && !select.disabled && select.value && option?.textContent.trim() === arguments[0]
        ? { id: select.value, name: option.textContent.trim() } : null;`, [name]);
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

/**
 * 建会话失败时打印被测应用与它的 WebView2 进程，供 CI 日志判断：
 * “DevToolsActivePort file doesn't exist” 说明应用活着但没有可调试的 WebView——
 * 是主线程卡住（Responding=False）、没建出窗口，还是 WebView2 没带上 msedgedriver 的参数。
 */
function reportProcesses() {
  const script = `
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    Get-Process -Name '${basename(application, ".exe")}' -ErrorAction SilentlyContinue |
      ForEach-Object { "应用 pid=$($_.Id) responding=$($_.Responding) window='$($_.MainWindowTitle)'" }
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
      Where-Object { $_.CommandLine -match 'webview-exe-name=${basename(application)}' -and $_.CommandLine -notmatch '--type=' } |
      ForEach-Object { "WebView2 pid=$($_.ProcessId) parent=$($_.ParentProcessId) $($_.CommandLine)" }`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  console.error(`建会话失败时的进程：\n${(out.stdout || "").trim() || "（没有被测应用或它的 WebView2 进程）"}`);
}

/** Force this exact test executable to exit; this is a restart check, not normal tray Quit. */
async function quitApp() {
  const script = `
    $own = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_SMOKE_EXE })
    $own | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $own.ProcessId | ConvertTo-Json -Compress`;
  const stopped = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, KINSHOKO_SMOKE_EXE: application }, windowsHide: true, encoding: "utf8",
  });
  if (stopped.status !== 0) throw new Error(`无法核对测试程序：${stopped.stderr}`);
  await until("应用进程退出", () => {
    const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_SMOKE_EXE }).Count"], {
      env: { ...process.env, KINSHOKO_SMOKE_EXE: application }, windowsHide: true, encoding: "utf8",
    });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout.trim() === "0";
  });
}

const button = (name) => `//button[normalize-space()='${name}']`;

function assert(ok, message) {
  if (!ok) throw new Error(`断言失败：${message}`);
  result.assertions.push(message);
  console.log(`✓ ${message}`);
}

const driverArgs = ["--port", String(port), "--native-port", String(port + 1), ...(edgeDriverArg ? ["--native-driver", resolve(edgeDriverArg)] : [])];
const driver = spawn(process.argv[4] ?? "tauri-driver", driverArgs, {
  env: { ...process.env, KINSHOKO_DATA_DIR: dataDir, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  windowsHide: true,
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
  const created = await until("打开新资料库", () => session.currentLibrary("冒烟测试库"));
  result.library = created;
  assert(true, "建立资料库并打开");

  // 导入文件夹（含子文件夹）
  await session.click(await session.find("//button[@aria-label='导入参考图']"));
  await until("保存目标资料库已加载", () => session.exec("return [...document.querySelector('select[aria-label=\"保存到资料库\"]').options].some(o=>o.value===arguments[0]);", [created.id]));
  await session.exec("const s=document.querySelector('select[aria-label=\"保存到资料库\"]');s.value=arguments[0];s.dispatchEvent(new Event('change',{bubbles:true}));",[created.id]);
  await session.exec("const s=document.querySelector('select[aria-label=\"保存到文件夹\"]');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));");
  await session.pick(source);
  await session.click(await session.find(button("导入文件夹…")));
  await session.waitFor("目标确认", button("开始导入"));
  await session.click(await session.find(button("开始导入")));
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
    [0.5, 1, 2].every((r, i) => Math.abs(sorted[i] - r) < 0.05),
    `瀑布流按原比例显示（${sorted.map((r) => r.toFixed(2)).join("、")}）`,
  );

  // 关闭后重开。应用常驻托盘（#61），关掉窗口进程仍在，单实例插件会把新启动交给它；
  // 所以只结束精确测试 exe，检查进程重启后的恢复；不声称正常托盘退出通过。
  await session.close();
  session = null;
  await quitApp();
  session = await Session.start();
  const reopened = await until("重开后打开上次的资料库", () => session.currentLibrary("冒烟测试库"));
  assert(reopened.id === created.id, "重开后仍使用同一资料库身份");
  const after = await until("重开后的缩略图", async () => {
    const w = await session.wall();
    return w.ids.length === 3 && w.loaded ? w : null;
  });
  assert(JSON.stringify(after.ids) === JSON.stringify(before.ids), "重开后资料库与图片墙原样恢复");
  await session.close();
  session = null;
  result.status = "passed";
  console.log("冒烟测试通过");
} catch (e) {
  result.status = "failed";
  result.error = String(e);
  if (session) {
    await session.exec("return document.documentElement.outerHTML").then(html => writeFileSync(join(work, "failure.html"), html)).catch(() => {});
    await wd("GET", `${session.base}/screenshot`).then(data => writeFileSync(join(work, "failure.png"), Buffer.from(data, "base64"))).catch(() => {});
  }
  console.error(e);
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  await quitApp().catch(() => {});
  driver.kill();
  result.completedAt = new Date().toISOString();
  writeFileSync(join(work, "result.json"), JSON.stringify(result, null, 2));
}
