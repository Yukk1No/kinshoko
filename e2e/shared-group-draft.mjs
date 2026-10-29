// #78 T05 native supplement: keep a rename draft and focus across real monitor cycles.
// Usage: node e2e/shared-group-draft.mjs <owned exe> <matching edgedriver> <passed run directory> <tauri-driver>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, passedArg] = process.argv;
if (!appArg || !edgeArg || !passedArg) throw new Error("Usage: node e2e/shared-tag-groups.mjs <kinshoko.exe> <msedgedriver.exe>");
const application = resolve(appArg);
const sourceManifest = JSON.parse(readFileSync("work/t05/native-source.json", "utf8"));
const source = sourceManifest.commit;
const harnessSource = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
if (binarySha256.toLowerCase() !== sourceManifest.binarySha256.toLowerCase()) throw new Error("Native binary does not match its source manifest");
const passed = resolve(passedArg);
if (!passed.startsWith(resolve("work", "e2e") + sep)) throw new Error("Passed fixture must belong to this worktree");
const prior = JSON.parse(readFileSync(join(passed, "result.json"), "utf8"));
if (prior.status !== "passed" || prior.source !== source || prior.binarySha256 !== binarySha256) throw new Error("Passed fixture source mismatch");
const work = resolve("work", "e2e", `group-draft-${Date.now()}`);
mkdirSync(work, { recursive: true });
cpSync(join(passed, "app-data"), join(work, "app-data"), { recursive: true, errorOnExist: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
mkdirSync(join(work, "roaming")); mkdirSync(join(work, "local"));
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4464);
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
const driver = spawn(process.argv[5] ?? "tauri-driver", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: join(work, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
let session;
const setting = "//button[@aria-label='设置' or normalize-space()='设置']";


try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((r) => r.ok));
  session = await Session.start();
  await session.click(setting);
  const groupPath = "//section[@aria-label='全局标签分组']//div[@role='group' and @aria-label='安全整理后']";
  const rename = `${groupPath}//button[@aria-label='改名标签分组“安全整理后”']`;
  await until("loaded global rename control", () => session.find(rename));
  const revisionBefore = await session.invoke("workspace_status", { safeMode: true });
  await session.click(rename);
  const field = "//input[@aria-label='标签分组名称']";
  await session.set(field, "跨周期整理完成");
  const readDraft = () => session.exec("const input = document.querySelector('input[aria-label=标签分组名称]'); return { value: input?.value, focused: input === document.activeElement }; ");
  const before = await readDraft();
  assert(before.focused && before.value === "跨周期整理完成", "formal rename draft has focus and the typed text");
  const started = Date.now(); await delay(2300); const elapsedMs = Date.now() - started;
  const after = await readDraft();
  const revisionAfter = await session.invoke("workspace_status", { safeMode: true });
  assert(elapsedMs >= 1500 && revisionAfter.revision === revisionBefore.revision, "native draft remains in an unchanged workspace across the 1.5 second monitor period");
  assert(after.focused && after.value === before.value, "monitor period preserves rename text and keyboard focus");
  await session.screenshot("rename-draft-after-monitor-period.png");
  await session.key("\uE007");
  await until("saved native draft", async () => (await session.invoke("shared_tag_groups", { lang: "zh-CN", safeMode: true })).some((group) => group.name === "跨周期整理完成"));
  assert(true, "Enter saves the preserved native rename draft through public group IPC");
  const receipt = join(work, "draft-normal-quit.json");
  const quit = spawnSync("python", ["e2e/native-tray-exit-t05.py", application, receipt], { windowsHide: true, encoding: "utf8", timeout: 45000 });
  assert(quit.status === 0 && JSON.parse(readFileSync(receipt, "utf8")).processEnded, "draft supplement exits through the verified real tray Quit callback");
  await session.close().catch(() => {}); session = null;
  writeFileSync(join(work,"result.json"),JSON.stringify({status:"passed",source,harnessSource,binarySha256,application,fixtureCopyFrom:passed,priorResultSha256:createHash("sha256").update(readFileSync(join(passed,"result.json"))).digest("hex"),elapsedMs,before,after,revisionBefore:revisionBefore.revision,revisionAfter:revisionAfter.revision,assertions},null,2));
  console.log(`Evidence: ${work}`);
} catch (error) {
  console.error(error);
  if (session) { await session.screenshot("failure.png").catch(() => {}); await session.exec("return document.body.outerHTML").then((html) => writeFileSync(join(work,"failure.html"),html)).catch(() => {}); }
  writeFileSync(join(work,"result.json"),JSON.stringify({status:"failed",source,harnessSource,binarySha256,application,assertions,error:String(error)},null,2)); process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if (driver.pid) spawnSync("taskkill",["/PID",String(driver.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
}
