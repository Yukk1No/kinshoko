// #290：在真实应用里量“从按 Del 删除到图片墙结果稳定”的耗时，修复前后各跑一次比较。
//
// 用法（PowerShell，先构建：npx tauri build --no-bundle）：
//   node scripts/perf/wall-fixture.mjs <样本目录> 2400 1
//   node e2e/wall-delete-perf.mjs <kinshoko.exe> <与 WebView2 同版本的 msedgedriver.exe> <样本目录> [每种张数的轮数=3]
//
// 步骤：建一个资料库并导入样本 → 窗口最大化、浏览它的全部图片 → 每轮 Ctrl 单击选中墙顶部的 N 张（1 张、20 张），
// 在卡片上按 Del。页面里逐帧记录：卡片离开墙的时刻、墙上张数变成删后张数的时刻，以及墙最后一次变化（卡片增减、
// 位置、张数）的时刻；之后 1.5 秒内没有再变化才算稳定。每种张数在“只读了第一页”与“滚到底读完全部页”两种墙上各跑。
// 每轮结束点轻提示里的“撤销”，等墙恢复原来的张数再进下一轮。
// 数据目录与 WebView2 配置都在 work/e2e/ 下的新目录里，不碰本设备的正式资料库。结果写到该目录的 result.json。

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [, , appArg, edgeArg, samplesArg, roundsArg] = process.argv;
if (!appArg || !edgeArg || !samplesArg) {
  console.error("用法：node e2e/wall-delete-perf.mjs <kinshoko.exe> <msedgedriver.exe> <样本目录> [每种张数的轮数=3]");
  process.exit(2);
}
const application = resolve(appArg);
const samples = resolve(samplesArg);
const rounds = Number(roundsArg ?? 3);
const SIZES = [1, 20];
/** 两种墙：只读了第一页（刚打开），与滚到底读完全部页（删除后整墙重读最重的情况）。 */
const SCENARIOS = ["first-page", "all-loaded"];
const QUIET_MS = 1500;
const fixture = JSON.parse(readFileSync(join(samples, "fixture.json"), "utf8"));
const expected = new Set(fixture.images.map((image) => image.sha256)).size;
const work = resolve("work", "e2e", `wall-delete-perf-${Date.now()}`);
mkdirSync(work, { recursive: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
const port = Number(process.env.KINSHOKO_PERF_PORT ?? 4470);
const driverUrl = `http://127.0.0.1:${port}`;

async function wd(method, path, body) {
  const response = await fetch(driverUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value).slice(0, 400)}`);
  return result.value;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, read, timeout = 30000, every = 150) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (reason) { error = reason; }
    await delay(every);
  }
  throw new Error(`等待超时：${label}${error ? `（${error.message}）` : ""}`);
}
class Session {
  static async start() {
    const value = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
    const session = new Session(value.sessionId);
    await until("Tauri IPC", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async run(script, args = []) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then(value => done({ value }), error => done({ failure: String(error?.stack ?? error) }));`, args });
    if (result?.failure) throw new Error(result.failure);
    return result.value;
  }
  invoke(command, args = {}) { return this.run("return await window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]);", [command, args]); }
  async screenshot(file) { writeFileSync(file, Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}

/** 页面里跑的一轮：选中墙顶部 N 张、按 Del，逐帧记录到稳定为止。 */
const ROUND = `
  const [count, quiet, total] = arguments;
  const wall = document.querySelector('.wall');
  const canvas = wall.querySelector('.wall-canvas');
  const top = [...canvas.querySelectorAll('.card')]
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top >= wall.getBoundingClientRect().top && rect.width > 0)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .slice(0, count).map(({ node }) => node);
  if (top.length < count) throw new Error('墙顶部的卡片不够 ' + count + ' 张');
  const ids = top.map((node) => node.dataset.id);
  // 像人一样一张张点：每次点击后等界面按新的选择渲染完。
  for (const node of top) {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 400));
  const chosen = canvas.querySelectorAll('.card[aria-selected="true"]').length;
  if (chosen !== count) throw new Error('选中了 ' + chosen + ' 张，应为 ' + count);
  let last = 0, removedAt = null, totalAt = null;
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(wall, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-total'] });
  const t0 = performance.now();
  last = t0;
  const target = canvas.querySelector('.card[data-id="' + CSS.escape(ids[0]) + '"]');
  target.focus();
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  await new Promise((resolve, reject) => {
    const deadline = t0 + 60000;
    const tick = () => {
      const now = performance.now();
      if (removedAt === null && ids.every((id) => !canvas.querySelector('.card[data-id="' + CSS.escape(id) + '"]'))) removedAt = now;
      if (totalAt === null && Number(wall.dataset.total) === total - count) totalAt = now;
      if (removedAt !== null && totalAt !== null && now - last >= quiet) return resolve();
      if (now > deadline) return reject(new Error('60 秒内没有稳定'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  observer.disconnect();
  const at = (t) => Math.round(t - t0);
  return {
    count, removedMs: at(removedAt), totalMs: at(totalAt), stableMs: at(Math.max(last, removedAt, totalAt)),
  };
`;


const result = { application, samples, expected, rounds, sizes: SIZES, quietMs: QUIET_MS, startedAt: new Date().toISOString() };
const save = () => writeFileSync(join(work, "result.json"), JSON.stringify(result, null, 2));
const driver = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
});
let session;
try {
  await until("tauri-driver", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await until("最大化按钮", () => session.exec("const b = document.querySelector('.k-win-btn[aria-label=\"最大化\"]'); if (!b) return false; b.click(); return true;"));
  await until("窗口已最大化", () => session.exec("return Boolean(document.querySelector('.k-win-btn[aria-label=\"还原\"]'));"));
  const library = await session.invoke("create_library", { parent: libraries, name: "删除耗时" });
  result.library = library.id;
  const importStart = Date.now();
  await session.invoke("start_import", { libraryId: library.id, source: { paths: [samples] } });
  await until("导入完成", async () => (await session.invoke("sidebar", { libraryId: library.id })).all === expected, 3_600_000, 1000);
  result.importMs = Date.now() - importStart;
  console.log(`导入 ${expected} 张：${result.importMs} ms`);
  await until("侧栏出现资料库", () => session.exec("return Boolean(document.querySelector(`[data-library-id=\"${arguments[0]}\"] .lib-head-name`));", [library.id]));
  await session.exec("document.querySelector(`[data-library-id=\"${arguments[0]}\"] .lib-head-name`).click();", [library.id]);
  await until(`图片墙满 ${expected}`, () => session.exec("return Number(document.querySelector('.wall')?.dataset.total) === arguments[0] && document.querySelectorAll('.wall .card').length > 20;", [expected]), 120000);
  await delay(3000);
  result.rounds = [];
  for (const scenario of SCENARIOS) {
    if (scenario === "all-loaded") {
      // 滚到底直到不再变高（各页都读到了），再回到顶部。
      let stable = 0, height = 0;
      while (stable < 4) {
        const next = await session.exec("const w = document.querySelector('.wall'); w.scrollTop = w.scrollHeight; return w.scrollHeight;");
        stable = next === height ? stable + 1 : 0;
        height = next;
        await delay(400);
      }
      await session.exec("document.querySelector('.wall').scrollTop = 0;");
      await delay(3000);
    }
    for (let round = 1; round <= rounds; round++) {
      for (const count of SIZES) {
        const entry = await session.run(ROUND, [count, QUIET_MS, expected]);
        entry.round = round;
        entry.scenario = scenario;
        result.rounds.push(entry);
        console.log(`${scenario} 第 ${round} 轮 ${count} 张`, JSON.stringify({ removedMs: entry.removedMs, totalMs: entry.totalMs, stableMs: entry.stableMs }));
        save();
        if (round === 1 && count === SIZES.at(-1)) await session.screenshot(join(work, `after-delete-${scenario}-${count}.png`));
        // 撤销：点轻提示里的“撤销”，等墙回到原来的张数并安静下来。
        await until("撤销按钮", () => session.exec("const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '撤销'); if (!b) return false; b.click(); return true;"), 10000);
        await until("撤销后张数恢复", () => session.exec("return Number(document.querySelector('.wall')?.dataset.total) === arguments[0];", [expected]), 60000);
        await delay(3000);
      }
    }
  }
  const summary = {};
  for (const scenario of SCENARIOS) for (const count of SIZES) {
    const runs = result.rounds.filter((r) => r.count === count && r.scenario === scenario);
    const median = (field) => runs.map((r) => r[field]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    summary[`${scenario}/${count}`] = { removedMs: median("removedMs"), totalMs: median("totalMs"), stableMs: median("stableMs") };
  }
  result.summary = summary;
  console.log("中位数", JSON.stringify(summary));
  result.status = "done";
} catch (error) {
  result.status = "failed";
  result.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
  if (session) await session.screenshot(join(work, "failure.png")).catch(() => {});
} finally {
  result.completedAt = new Date().toISOString();
  save();
  if (session) await wd("DELETE", session.base).catch(() => {});
  // 只结束本次 tauri-driver 进程树里的应用实例，不碰本机另开的同一构建。
  const cleanup = [
    "$all = @(Get-CimInstance Win32_Process); $tree = @{}",
    "$queue = [System.Collections.Generic.Queue[int]]::new(); $queue.Enqueue([int]$env:KINSHOKO_PERF_DRIVER_PID)",
    "while ($queue.Count) { $id = $queue.Dequeue(); if ($tree.ContainsKey($id)) { continue }; $tree[$id] = $true; foreach ($p in $all) { if ($p.ParentProcessId -eq $id) { $queue.Enqueue([int]$p.ProcessId) } } }",
    "$all | Where-Object { $tree.ContainsKey([int]$_.ProcessId) -and $_.ExecutablePath -eq $env:KINSHOKO_PERF_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  if (driver.pid) spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cleanup], { env: { ...process.env, KINSHOKO_PERF_EXE: application, KINSHOKO_PERF_DRIVER_PID: String(driver.pid) }, windowsHide: true });
  driver.kill();
  console.log(`结果：${join(work, "result.json")}`);
}
