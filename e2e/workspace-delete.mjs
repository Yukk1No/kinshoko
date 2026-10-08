// #78 T07: native follow-up for the T14 selected-image deletion lifecycle.
// Setup uses the same public Tauri actions as the UI; correspondence is corrected through rendered controls.
// Usage: node e2e/tag-identity.mjs <owned kinshoko.exe> <matching msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";

const [, , appArg, edgeArg, legacyArg] = process.argv;
if (!appArg || !edgeArg || !legacyArg) throw new Error("Usage: node e2e/workspace.mjs <kinshoko.exe> <msedgedriver.exe> <legacy-fixture-dir> <workspace-result.json>");
const application = resolve(appArg);
const work = resolve("work", "e2e", `workspace-delete-${Date.now()}`);
mkdirSync(work, { recursive: true });
const libraries = join(work, "libraries");
mkdirSync(libraries);
const imagePath = join(work, "image.png");
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
const row = Buffer.from([0, 18, 28, 38, 18, 28, 38, 18, 28, 38]);
writeFileSync(imagePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row, row]))), chunk("IEND", Buffer.alloc(0))]));
const port = 4450;
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
    const result = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
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
  click(xpath) { return this.find(xpath).then((id) => wd("POST", `${this.base}/element/${id}/click`, {})); }
  close() { return wd("DELETE", this.base); }
  async screenshot(name) { writeFileSync(join(work, name), Buffer.from(await wd("GET", `${this.base}/screenshot`), "base64")); }
}
function quitOwnApp() {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_E2E_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { env: { ...process.env, KINSHOKO_E2E_EXECUTABLE: application }, stdio: "ignore" });
}

const dataRoot = resolve(legacyArg);
const prior = JSON.parse(readFileSync(resolve(process.argv[5]), "utf8"));
const source = prior.source;
const binarySha256 = createHash("sha256").update(readFileSync(application)).digest("hex");
if (binarySha256 !== prior.binarySha256) throw new Error("native binary differs from workspace evidence");
const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", "4451", "--native-driver", resolve(edgeArg)], {
  env: { ...process.env, KINSHOKO_DATA_DIR: join(dataRoot, "app-data"), KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") },
  stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
let session;
try {
  await until("driver ready", () => fetch(`${driverUrl}/status`).then((response) => response.ok));
  session = await Session.start();
  await session.invoke("switch_library", { libraryId: prior.first.info.id });
  await session.close(); session = null; quitOwnApp(); await delay(700);
  session = await Session.start();
  await until("active library restored", async () => (await session.invoke("current_library"))?.id === prior.first.info.id);
  const before = await session.invoke("workspace_browse", { query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 128 }, safeMode: true });
  const target = before.cards[0];
  await session.invoke("edit", { libraryId: prior.first.info.id, ids: [target.imageId], edits: [{ kind: "delete" }] });
  await until("trash count", () => session.find("//button[@aria-label='回收站（1 张）']"));
  await session.click("//button[@aria-label='回收站（1 张）']");
  await until("trash card", () => session.find(`//*[@data-id='${target.id}']`));
  await session.exec("document.querySelector('.card').dispatchEvent(new KeyboardEvent('keydown', {key:' ',bubbles:true}));");
  await until("selected deletion control", () => session.find("//button[text()='永久删除…']"));
  await session.click("//button[text()='永久删除…']");
  await until("delete preview", () => session.find("//button[text()='确认永久删除']"));
  await session.click("//button[text()='确认永久删除']");
  await until("selection and trash card removed", () => session.exec("return !document.querySelector('.selection') && document.querySelector('.wall')?.dataset.total === '0';"));
  await delay(2000); // allow a full provider-monitor revision after the deletion event.
  assert(await session.exec("return ![...document.querySelectorAll('[role=alert]')].some(el => el.textContent.includes('资料库中没有这张参考图'));"), "permanent delete does not leave a stale detail error in formal UI");
  assert(await session.invoke("workspace_image", { libraryId: prior.first.info.id, imageId: target.imageId }).then(() => false, () => true), "deleted selected source is unavailable to new detail requests");
  await session.screenshot("permanent-delete-no-stale-detail.png");
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "passed", source, binarySha256, assertions, libraryId: prior.first.info.id, deletedImage: target.imageId }, null, 2));
  console.log(`Evidence: ${work}`);
} catch(error) {
  console.error(error);
  if (session) await session.screenshot("failure.png").catch(() => {});
  writeFileSync(join(work, "result.json"), JSON.stringify({ status: "failed", source, binarySha256, assertions, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => {});
  quitOwnApp();
  if(driver.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
