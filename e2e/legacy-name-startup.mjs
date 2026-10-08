// Only the supplementary T07 startup branch; reuses T04's already verified upgraded old libraries.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const [, , appArg, edgeArg, priorArg] = process.argv;
if (!appArg || !edgeArg || !priorArg) throw new Error("Usage: node e2e/legacy-name-startup.mjs <app> <edge> <prior-t04-run> [tauri-driver]");
const application = resolve(appArg), prior = resolve(priorArg);
if (!prior.startsWith(resolve("work/e2e") + "\\")) throw new Error("Prior data must stay inside this workspace work/e2e");
const work = resolve("work/e2e", `legacy-name-startup-${Date.now()}`); mkdirSync(work, { recursive: true });
const source = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4458);
const driverUrl = `http://127.0.0.1:${port}`;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
async function wd(method, path, body) {
  const response = await fetch(driverUrl + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(label, read, timeout = 30000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const result = await read(); if (result) return result; } catch (reason) { error = reason; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ""}`);
}
const assertions = [];
function assert(ok, label) { if (!ok) throw new Error(label); assertions.push(label); console.log(`PASS ${label}`); }
class Session {
  static async start() {
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
    const session = new Session(result.sessionId);
    await until("Tauri IPC ready", () => session.exec("return Boolean(window.__TAURI_INTERNALS__?.invoke);"));
    return session;
  }
  constructor(id) { this.base = `/session/${id}`; }
  exec(script, args = []) { return wd("POST", `${this.base}/execute/sync`, { script, args }); }
  async invoke(command, args = {}) {
    const result = await wd("POST", `${this.base}/execute/async`, { script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:library|' + arguments[0], arguments[1]).then(value => done({ value }), error => done({ failure: String(error) }));", args: [command, args] });
    if (result.failure) throw new Error(`${command}: ${result.failure}`);
    return result.value;
  }
  async find(xpath) { return (await wd("POST", `${this.base}/element`, { using: "xpath", value: xpath }))[ELEMENT]; }
  async click(xpath) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
      catch (error) {
        if (attempt >= 4 || !/stale element reference|no such element/.test(error.message)) throw error;
        await delay(150);
      }
    }
  }
  async set(xpath, value) {
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if (!element) throw Error('control missing'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(element, arguments[1]); element.dispatchEvent(new Event('input', { bubbles: true }));", [xpath, value]);
  }
  async select(xpath, value) {
    await until("enabled select option", () => this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return element && !element.disabled && [...element.options].some((option) => option.value === arguments[1]);", [xpath, value]));
    await this.exec("const element = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; element.value = arguments[1]; element.dispatchEvent(new Event('change', { bubbles: true }));", [xpath, value]);
  }
  key(value) { return wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }] }); }
  async controlClick(xpath) {
    await wd("POST", `${this.base}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: String.fromCharCode(0xE009) }] }] });
    try { await this.click(xpath); } finally { await wd("DELETE", `${this.base}/actions`); }
  }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, windowsHide: true, stdio: "ignore" });
}

const driver = spawn(process.argv[5] ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { env: { ...process.env, KINSHOKO_DATA_DIR: join(prior, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let session, fourth, moved = false;
async function normalExit(label) {
  const receiptPath = join(work, label + ".json");
  const result = spawnSync("python", ["e2e/native-tray-exit-t04.py", application, receiptPath], { windowsHide: true, encoding: "utf8", timeout: 45000 });
  if (result.status !== 0) throw new Error(`Native tray quit failed: ${result.stdout} ${result.stderr}`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert(receipt.processEnded && receipt.exitCode === 0 && receipt.menuClosedBeforeDispatch, `${label}: actual native tray Quit callback exits normally with code 0`);
  await session.close().catch(() => {}); session = null;
}
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  const entries = await session.invoke("registered_libraries");
  fourth = entries.find((entry) => entry.library.name === "旧名称第四库")?.library;
  assert(fourth && resolve(fourth.root) === join(prior, "libraries", "旧名称第四库"), "only the exact prior T04 fourth-library path can be disconnected");
  assert((await session.invoke("current_library"))?.id === fourth.id, "last active library is the previously upgraded fourth old library");
  await session.invoke("set_safe_mode", { on: false });
  assert(await session.invoke("safe_mode") === false, "saved safe=false is confirmed through the public action");
  await normalExit("before-disconnect-tray-exit");
  renameSync(fourth.root, fourth.root + ".offline"); moved = true;
  session = await Session.start();
  await until("workspace with no active library", () => session.exec("return document.querySelector('.wall')?.dataset.total === '1'"));
  assert(await session.invoke("safe_mode") === false, "saved non-safe view survives disconnected-active-library restart");
  const status = await session.invoke("workspace_status", { safeMode: false });
  assert(Boolean(status.libraries.find((entry) => entry.library.id === fourth.id)?.unavailable), "disconnected last-active provider has explicit unavailability");
  const page = await session.invoke("workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 20, thumbnailPx: 128 }, safeMode: false });
  assert(page.total === 1 && page.cards[0].sources.filter((entry) => !entry.unavailable).length === 3, "three other upgraded libraries still aggregate with saved safe=false");
  assert(await session.exec("return document.querySelector('[aria-label=\"查找范围\"] button[aria-current=page]')?.textContent === '全部资料库'"), "formal workspace defaults to all registered providers without an active library");
  await session.screenshot("formal-disconnected-active-startup.png");
  await normalExit("after-disconnect-tray-exit");
  renameSync(fourth.root + ".offline", fourth.root); moved = false;
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", source, binarySha256, application, priorMigrationRun: prior, supplementaryIntegration: "T07 saved safe=false, normal real tray quit, disconnected last-active path", assertions, environment: { configPath: join(process.env.APPDATA, "dev.kinshoko.spec78t04test", "settings.json"), profile: join(work, "webview") } }, null, 2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", source, binarySha256, application, assertions, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (moved) renameSync(fourth.root + ".offline", fourth.root);
  if (driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
