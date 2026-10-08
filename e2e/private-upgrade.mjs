// Real isolated NSIS old -> new installation. Uses production UI/IPC, never edits storage internals.
// Run only in the coordinated native slot. Quit each installed app from its tray when READY is printed.
// node e2e/private-upgrade.mjs <old-setup.exe> <new-setup.exe> <evidence-dir> <msedgedriver.exe>
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { release } from "node:os";
import { deflateSync } from "node:zlib";

const [, , oldArg, newArg, outputArg, edgeArg] = process.argv;
if (!oldArg || !newArg || !outputArg || !edgeArg) throw new Error("old/new installers, evidence directory and msedgedriver required");
const output = resolve(outputArg), installDir = join(output, "installed"), application = join(installDir, "kinshoko-t19-upgrade.exe");
const packages = { old: resolve(oldArg), new: resolve(newArg) };
const provenance = JSON.parse(readFileSync(join(output, "build-evidence.json"), "utf8"));
if (provenance.identifier !== "dev.kinshoko.spec78t19upgrade" || provenance.productName !== "Kinshoko T19 Upgrade Probe" || provenance.mainBinaryName !== "kinshoko-t19-upgrade") throw new Error("Isolation identity mismatch");
for (const kind of ["old", "new"]) if (hash(packages[kind]) !== provenance[kind].installerSha256) throw new Error(`${kind} installer hash mismatch`);
const work = join(output, `run-${Date.now()}`), data = join(work, "app-data"), parent = join(work, "libraries"), source = join(work, "source");
for (const dir of [output, work, data, parent, source, join(work, "roaming"), join(work, "local")]) mkdirSync(dir, { recursive: true });
const port = Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4534), endpoint = `http://127.0.0.1:${port}`;
const report = { ticket: 97, stories: [50], sourceRevision: provenance.new.sourceRevision, oldSourceRevision: provenance.old.sourceRevision, windows: release(), provenance, work, installDir, checks: [], status: "running" };
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
function hash(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function save() { writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); }
function check(ok, label) { if (!ok) throw new Error(label); report.checks.push(label); save(); console.log(`PASS ${label}`); }
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(label, read, timeout = 30000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const result = await read(); if (result) return result; } catch (error) { last = error; } await delay(200); } throw new Error(`${label}: timeout${last ? ` (${last.message})` : ""}`); }
async function wd(method, path, body) {
  const response = await fetch(endpoint + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok || result.status || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return path === "/session" && result.sessionId ? { sessionId: result.sessionId, capabilities: result.value } : result.value;
}
let base, driver;
const exec = (script, args = []) => wd("POST", `${base}/execute/sync`, { script, args });
async function invoke(command, args = {}) {
  const result = await wd("POST", `${base}/execute/async`, { script: "const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}), error=>done({ok:false,error:String(error)}));", args: [command, args] });
  if (!result.ok) throw new Error(`${command}: ${result.error}`); return result.value;
}
const lib = (name, args = {}) => invoke(`plugin:library|${name}`, args);
const desktop = (name, args = {}) => invoke(`plugin:desktop|${name}`, args);
const windows = () => invoke("plugin:window|get_all_windows");
async function click(xpath) { const el = await wd("POST", `${base}/element`, { using: "xpath", value: xpath }); await wd("POST", `${base}/element/${el[elementKey] ?? el.ELEMENT}/click`, {}); }
async function screenshot(name) { writeFileSync(join(output, `${name}.png`), Buffer.from(await wd("GET", `${base}/screenshot`), "base64")); }
function isRunning() { const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq kinshoko-t19-upgrade.exe", "/NH"], { windowsHide: true, encoding: "utf8" }); return result.stdout.toLowerCase().includes("kinshoko-t19-upgrade.exe"); }
function install(kind) {
  if (isRunning()) throw new Error("Probe app must exit before installing");
  const result = spawnSync(packages[kind], ["/S", `/D=${installDir}`], { windowsHide: true, timeout: 120000, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${kind} installer failed: ${result.status} ${result.error ?? result.stderr}`);
  check(existsSync(application) && existsSync(join(installDir, "DirectML.dll")) && existsSync(join(installDir, "uninstall.exe")), `${kind} real NSIS installed exe, DirectML and uninstaller`);
  check(hash(application) === provenance[kind].exeSha256, `${kind} installed executable matches built source artifact`);
  report[`${kind}InstalledVersion`] = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${application.replaceAll("'", "''")}').VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress`], { windowsHide: true, encoding: "utf8" }).stdout.trim();
  save();
}
async function start() {
  driver = spawn(process.env.KINSHOKO_TAURI_DRIVER ?? "C:/Users/yuk1no/.cargo/bin/tauri-driver.exe", ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], {
    windowsHide: true, env: { ...process.env, APPDATA: join(work, "roaming"), LOCALAPPDATA: join(work, "local"), KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: join(work, "webview") }, stdio: ["ignore", "inherit", "inherit"] });
  await until("driver ready", () => fetch(`${endpoint}/status`).then(r => r.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: join(work, "webview") } } } } });
  base = `/session/${session.sessionId}`; report.runtime = session.capabilities;
  await until("IPC ready", () => invoke("app_info"));
}
async function stopDriver() {
  if (base) { try { await wd("DELETE", base); } catch {} base = null; }
  if (driver) { spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); driver.kill(); driver = null; }
}
async function trayExit(kind) {
  report.phase = `${kind}-ready-for-tray-exit`; save(); console.log(`READY ${kind.toUpperCase()} FOR NORMAL TRAY EXIT`);
  await until("normal tray exit", () => !isRunning(), 900000);
  check(true, `${kind} app exited normally through native tray menu (operator action)`);
  await stopDriver(); await delay(500);
}
function png() {
  const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const width = 512, height = 320, header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = y * (1 + width * 3) + 1 + x * 3; raw[p] = x % 256; raw[p + 1] = y % 256; raw[p + 2] = (x + y) % 256; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const browse = libraryId => lib("browse", { libraryId, query: { scope: { kind: "all" }, conditions: { conditions: [] }, cursor: null, limit: 100, thumbnailPx: 256 } });
function settings(view) { return { autostart: view.autostart, showApproxSource: view.showApproxSource, forceSrgb: view.forceSrgb, usageLog: view.usageLog, shortcuts: view.shortcuts.map(s => ({ action: s.action, accelerator: s.accelerator })) }; }
let before;
try {
  install("old"); await start();
  const oldStatus = await invoke("update_status"); check(oldStatus.state === "disabled", "fixed baseline old installed app starts with unsigned updater disabled");
  writeFileSync(join(source, "upgrade-pattern.png"), png());
  const field = await until("old onboarding", async () => { const el = await wd("POST", `${base}/element`, { using: "xpath", value: "//label[contains(.,'资料库名称')]/input" }); return el[elementKey] ?? el.ELEMENT; });
  await wd("POST", `${base}/element/${field}/clear`, {}); await wd("POST", `${base}/element/${field}/value`, { text: "T19 升级资料库" });
  await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [parent]); await click("//button[normalize-space()='选择存放位置…']"); await click("//button[normalize-space()='建立资料库']");
  const library = await until("old current library", () => lib("current_library"));
  await exec("window.__KINSHOKO_TEST_PICKS__=[arguments[0]]", [source]); await click("//button[normalize-space()='导入文件夹…']");
  const page = await until("old import", async () => { const p = await browse(library.id); return p.total === 1 ? p : null; }, 60000);
  const imageId = page.cards[0].id;
  await invoke("set_autostart", { on: false }); await invoke("set_show_approx_source", { on: true }); await invoke("set_usage_log", { on: true });
  for (const action of ["capture", "pinClipboard", "hideAllPins"]) await invoke("rebind_shortcut", { action, accelerator: null });
  await desktop("pin_reference", { libraryId: library.id, imageId, crop: { x: 32, y: 24, width: 200, height: 160 }, shown: { x: 240, y: 180, width: 200, height: 160 } });
  const pinLabel = await until("old pin window", async () => (await windows()).find(label => label.startsWith("pin-"))), pinId = pinLabel.slice(4);
  await desktop("zoom_pin", { pin: pinId, scale: 0.75, anchorX: 240, anchorY: 180 });
  await desktop("turn_pin", { pin: pinId, turn: "flipHorizontal" }); await desktop("turn_pin", { pin: pinId, turn: "rotateClockwise" });
  await desktop("move_pin", { pin: pinId, x: 160, y: 120 }); await desktop("set_pin_opacity", { pin: pinId, opacity: 0.6 }); await desktop("set_pin_locked", { pin: pinId, locked: true });
  const group = await desktop("save_reference_group", { name: "T19 旧版升级参考组", captures: [] });
  before = { library, imageId, registrations: await lib("registered_libraries"), settings: settings(await invoke("shell_settings")), group: (await desktop("reference_group", { groupId: group.id })).group, pin: (await desktop("pin_frame", { pin: pinId })).pin, safeMode: await lib("safe_mode") };
  report.before = before; save(); await screenshot("old-installed-state"); await trayExit("old");
  install("new"); check(provenance.old.exeSha256 !== provenance.new.exeSha256, "old and new installed program bytes differ"); await start();
  const libraryAfter = await until("new restores library", () => lib("current_library"));
  check(JSON.stringify(libraryAfter) === JSON.stringify(before.library), "new installed app preserves the registered and last-opened library");
  check(JSON.stringify(await lib("registered_libraries")) === JSON.stringify(before.registrations), "new installed app preserves all library registrations and paths");
  check(JSON.stringify(settings(await invoke("shell_settings"))) === JSON.stringify(before.settings), "new installed app preserves non-default settings and shortcuts");
  const groups = await desktop("reference_groups"); check(groups.some(g => g.id === before.group.id && g.name === before.group.name), "new installed app lists the old reference group");
  const groupAfter = await desktop("reference_group", { groupId: before.group.id });
  check(JSON.stringify(groupAfter.group) === JSON.stringify(before.group), "new installed app preserves reference group members, source, crop and placement");
  const frame = await until("new restored native pin", () => desktop("pin_frame", { pin: before.pin.id }));
  check(JSON.stringify(frame.pin) === JSON.stringify(before.pin), "new installed app restores pin identity, source, crop, geometry, flip, rotation, opacity, lock and membership");
  check(!frame.veiled && !frame.unavailable, "restored old pin resolves real image content in the new native app");
  check((await browse(libraryAfter.id)).cards.some(c => c.id === before.imageId), "new installed app reads the old real SQLite library and imported original");
  check((await lib("safe_mode")) === before.safeMode, "new installed app preserves safe mode");
  const status = await invoke("update_status"), checked = await invoke("check_update");
  check(status.state === "manual" && checked.state === "manual" && checked.message.includes("私有阶段"), "new installed private build reports manual updates even on explicit check");
  let refused = ""; try { await invoke("install_update"); } catch (error) { refused = error.message; }
  check(refused.includes("手动更新"), "new installed private build refuses automatic install at the command boundary");
  await click("//button[@aria-label='设置' or @title='设置' or normalize-space()='设置']");
  await until("new private update UI", () => exec("return document.body.textContent.includes('当前为私有阶段，请使用新版安装包手动更新。')"));
  check(await exec("return ![...document.querySelectorAll('button')].some(b=>['检查更新','安装并重启'].includes(b.textContent.trim()))"), "new installed settings show manual guidance without automatic actions");
  await screenshot("new-manual-update-settings");
  report.after = { library: libraryAfter, settings: settings(await invoke("shell_settings")), group: groupAfter, pin: frame.pin, updateStatus: status }; save();
  await trayExit("new");
  const uninstaller = join(installDir, "uninstall.exe");
  const removed = spawnSync(uninstaller, ["/S", `_?=${installDir}`], { windowsHide: true, timeout: 120000, encoding: "utf8" });
  check(removed.status === 0 && !existsSync(application), "only the isolated test product was uninstalled after verification");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error);
  if (base) { try { writeFileSync(join(output, "failure.html"), await wd("GET", `${base}/source`)); await screenshot("failure"); } catch {} }
  throw error;
} finally { report.finishedAt = new Date().toISOString(); save(); await stopDriver(); }
