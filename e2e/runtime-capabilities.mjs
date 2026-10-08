// #78 T18 / #96 story 51. Current native WebView2, plus explicitly controlled JS absences.
// Controlled absences do not represent Windows 10 or an actual older/absent Runtime.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { initialHiddenPin, inspectNativePin } from "./native-initial-pin-t18.mjs";

const [, , appArg, edgeArg, driverArg = "C:/Users/yuk1no/.cargo/bin/tauri-driver.exe", runArg, mode = "full"] = process.argv;
if (!appArg || !edgeArg) throw Error("Frozen T18 executable and matching WebView2 driver required");
if (!["full", "main", "pin-error"].includes(mode)) throw Error("T18 scope must be full, main, or pin-error");
const manifest = JSON.parse(readFileSync("work/t18/native-source.json", "utf8"));
const application = resolve(appArg), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (application.toLowerCase() !== resolve(manifest.preservedBinary).toLowerCase() || hash(readFileSync(application)) !== manifest.binarySha256) throw Error("Wrong frozen product");
for (const [name, path] of [["edge", edgeArg], ["tauri", driverArg]]) {
  const frozen = manifest.drivers[name];
  if (resolve(path).toLowerCase() !== resolve(frozen.path).toLowerCase() || hash(readFileSync(path)) !== frozen.sha256) throw Error("Wrong frozen " + name + " driver");
}
if (hash(readFileSync(manifest.buildConfig.path)) !== manifest.buildConfig.sha256) throw Error("Frozen test-bundle configuration changed");
if (mode === "pin-error") {
  const config = JSON.parse(readFileSync(manifest.buildConfig.path, "utf8"));
  const expected = ["default", "desktop", { identifier: "t18-test-pin-hide", description: "Isolated native test bundle only: framework hide before a controlled pin failure", windows: ["pin-*"], permissions: ["core:window:allow-hide"] }];
  if (JSON.stringify(config.app?.security?.capabilities) !== JSON.stringify(expected)) throw Error("Pin-error scope requires the exact isolated test-only hide capability");
}
const work = resolve(runArg ?? join("work/e2e", "runtime-capabilities-" + Date.now()));
if (dirname(work) !== resolve("work/e2e") || !/^runtime-capabilities-\d+$/.test(basename(work)) || existsSync(work)) throw Error("A new owned T18 evidence directory is required");
const data = join(work, "app-data"), profile = join(work, "webview"), parent = join(work, "libraries"), source = join(work, "source");
for (const path of [data, profile, parent, source]) mkdirSync(path, { recursive: true });
const gitRead = (...args) => {
  const result = spawnSync("git", args, { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw Error(result.stderr);
  return result.stdout.trim();
};
if (gitRead("status", "--porcelain")) throw Error("A clean harness source is required");
const productionChanges = Object.entries(manifest.sourceFiles).filter(([path, expected]) => !path.startsWith("e2e/") && hash(readFileSync(path)) !== expected).map(([path]) => path);
if (productionChanges.length) throw Error("Frozen production inputs changed: " + productionChanges.join(", "));
if (Object.entries(manifest.distFiles).some(([path, expected]) => hash(readFileSync(path)) !== expected)) throw Error("Frozen frontend dist changed");
const harnessFiles = ["e2e/runtime-capabilities.mjs", "e2e/native-save-dialog-t18.ps1", "e2e/native-pin-inspect-t18.py", "e2e/native-initial-pin-t18.mjs"];
mkdirSync(join(work, "harness"));
for (const path of harnessFiles) copyFileSync(path, join(work, "harness", basename(path)));
copyFileSync("work/t18/native-source.json", join(work, "native-source.json"));
copyFileSync(manifest.buildConfig.path, join(work, "tauri.test.json"));
const knownFolderConfig = resolve(manifest.knownFolderConfig);
const expectedKnownFolder = resolve(process.env.USERPROFILE, "AppData", "Roaming", "dev.kinshoko.spec78t18test", "settings.json");
if (manifest.identifier !== "dev.kinshoko.spec78t18test" || knownFolderConfig.toLowerCase() !== expectedKnownFolder.toLowerCase()) throw Error("Unmatched isolated KnownFolder config");
if (existsSync(knownFolderConfig)) throw Error("The isolated KnownFolder settings must not preexist: " + knownFolderConfig);
const report = {
  story: 51, ticket: 96, mode, source: manifest.commit, tree: manifest.tree, binarySha256: manifest.binarySha256,
  scope: mode === "pin-error" ? "Framework-hide then controlled required-canvas failure; production ready must show the same native HWND" : mode === "main" ? "Independent main-window continuation; no pin error path" : "Full runtime capability attempt",
  identifier: manifest.identifier, ports: manifest.ports, work, application, data, profile,
  harness: { source: gitRead("rev-parse", "HEAD"), tree: gitRead("rev-parse", "HEAD^{tree}"), clean: true, files: Object.fromEntries(harnessFiles.map((path) => [path, hash(readFileSync(path))])), frozenProductionInputsMatch: true, frozenDistMatches: true },
  knownFolder: { config: knownFolderConfig, existedBefore: false },
  limitations: ["Windows 10 unverified: owner has no device/VM", "Controlled JS absence in current Runtime is not an old/absent Runtime", "Basic capabilities and representative display are not a colour-fidelity pass"], checks: [],
};
if (mode === "main") report.limitations.push("Main-only run: initial-hidden missing-canvas pin path is not executed or verified by this result");
if (mode === "pin-error") report.limitations.push("Test bundle alone grants public framework hide to pin-*; this does not verify the first-script initial-hidden path or a genuinely older Runtime");
function chunk(kind, bytes) {
  const body = Buffer.concat([Buffer.from(kind), bytes]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  const size = Buffer.alloc(4), tail = Buffer.alloc(4); size.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, tail]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(400); header.writeUInt32BE(300, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc((400 * 3 + 1) * 300);
for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
  const at = y * 1201 + 1 + x * 3; const border = x < 8 || x > 391 || y < 8 || y > 291;
  pixels[at] = border ? 255 : Math.round(x / 400 * 255); pixels[at + 1] = border ? 255 : Math.round(y / 300 * 255); pixels[at + 2] = border ? 255 : 100;
}
const sampleFile = join(source, "PRIVATE_REFERENCE_NAME.png");
writeFileSync(sampleFile, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
const originalHash = hash(readFileSync(sampleFile));
const port = manifest.ports[0], endpoint = `http://127.0.0.1:${port}`, elementKey = "element-6066-11e4-a52e-4f735466cecf";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let driver, base, mainHandle, pinHandle, initialPinProof;
async function wd(method, path, body) {
  const response = await fetch(endpoint + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
async function until(label, read, timeout = 30000) {
  let error; const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (reason) { error = reason; } await delay(100); }
  throw Error(`Timed out: ${label}${error ? ": " + error.message : ""}`);
}
const exec = (script, args = []) => wd("POST", base + "/execute/sync", { script, args });
async function invoke(command, args = {}) {
  const result = await wd("POST", base + "/execute/async", { script: "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({failure:String(error)}));", args: [command, args] });
  if (result.failure) throw Error(command + ": " + result.failure);
  return result.value;
}
async function find(xpath) { return (await wd("POST", base + "/element", { using: "xpath", value: xpath }))[elementKey]; }
async function click(xpath) { return wd("POST", base + "/element/" + await find(xpath) + "/click", {}); }
const button = (name) => `//button[normalize-space()='${name}']`;
async function closeCurrentPin() {
  const label = await exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label");
  const handle = await wd("GET", base + "/window");
  if (!label.startsWith("pin-") || handle === mainHandle) throw Error("Only the current owned production pin can be closed");
  // Destruction can remove this WebView before its async callback reaches WebDriver.
  // Accept a null response only for this operation, paired with actual handle removal.
  const response = await wd("POST", base + "/execute/async", { script: "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:desktop|close_pin',{pin:arguments[0]}).then(value=>done({value}),error=>done({failure:String(error)}));", args: [label.slice(4)] });
  (report.pinCloseObservations ??= []).push({ label, handle, response });
  if (response?.failure) throw Error("close_pin: " + response.failure);
  await until("closed production pin handle removed", async () => !(await wd("GET", base + "/window/handles")).includes(handle));
  await wd("POST", base + "/window", { handle: mainHandle });
}
const screenshot = async (name) => writeFileSync(join(work, name), Buffer.from(await wd("GET", base + "/screenshot"), "base64"));
function check(ok, label) { if (!ok) throw Error(label); report.checks.push(label); console.log("PASS " + label); }
async function pinCanvasSource() {
  return exec("const c=document.querySelector('.pin-canvas');if(!c||!c.width||!c.height)return false;const ctx=c.getContext('2d'),attributes=ctx.getContextAttributes();try{const d=ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;return d[3]===255&&!(d[0]===138&&d[1]===138&&d[2]===142)?{width:c.width,height:c.height,attributes,pixelReadback:'available'}:false}catch(error){if(error.name==='SecurityError')return {width:c.width,height:c.height,attributes,pixelReadback:'blocked by actual cross-origin source'};throw error}");
}
function pinScreenshotSamples(name) {
  const measured = spawnSync("python", ["-c", "from PIL import Image; import json,sys; im=Image.open(sys.argv[1]).convert('RGB'); w,h=im.size; points=[(2,2),(w-3,2),(2,h-3),(w-3,h-3),(w//2,h//2)]; print(json.dumps({'size':[w,h],'samples':[list(im.getpixel(p)) for p in points]}))", join(work, name)], { windowsHide: true, encoding: "utf8" });
  if (measured.status !== 0) throw Error("Owned pin screenshot read: " + measured.stderr);
  const pixels = JSON.parse(measured.stdout), centre = pixels.samples[4];
  // Only establish that the synthetic white-border gradient is visible, not colour fidelity.
  check(pixels.samples.slice(0, 4).every((pixel) => pixel.every((channel) => channel >= 240)) && centre[0] >= 80 && centre[0] <= 180 && centre[1] >= 80 && centre[1] <= 180 && centre[2] >= 50 && centre[2] <= 150, "native screenshot shows the synthetic pin gradient and white border: " + name);
  (report.pinScreenshots ??= {})[name] = pixels;
}
async function cdp(command, params) {
  let failure;
  for (const prefix of ["ms", "goog"]) {
    try { return await wd("POST", base + `/${prefix}/cdp/execute`, { cmd: command, params }); } catch (error) { failure = error; }
  }
  throw failure;
}
async function injectNextDocument(script) {
  const added = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: script });
  await exec("location.reload()");
  await until("pin production document reloaded", () => exec("return document.querySelector('.pin') && window.__T18_CONTROLLED_ABSENCE__"));
  return added.identifier;
}
function reportPrivacy(text) {
  for (const secret of ["PRIVATE_REFERENCE_NAME", sampleFile, work, "\\Users\\", "/Users/", "yuk1no"]) check(!text.includes(secret), "diagnostic text excludes " + secret.replaceAll(work, "<owned evidence path>"));
}
async function diagnosticFile(name, prefix = "") {
  const file = join(work, name);
  await click(`${prefix}//button[normalize-space()='存成文件…']`);
  const saved = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "e2e/native-save-dialog-t18.ps1", application, file], { windowsHide: true, encoding: "utf8", timeout: 25000 });
  writeFileSync(join(work, name + ".save-dialog.json"), saved.stdout);
  if (saved.status !== 0) throw Error("Native report Save dialog: " + saved.stderr);
  await until("native diagnostic file saved", () => existsSync(file));
  const text = readFileSync(file, "utf8"); reportPrivacy(text); return text;
}
const setting = "//button[@aria-label='设置']";
const details = "//section[@aria-label='本机运行时']";
const mainFaultScript = "window.__T18_ORIGINAL_CONTEXT__ ??= HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(kind,options){if(kind==='2d' && options?.colorType==='float16')throw new TypeError('Controlled current Runtime float16 absence');return window.__T18_ORIGINAL_CONTEXT__.apply(this,arguments)};window.__T18_ORIGINAL_BITMAP__=window.createImageBitmap;window.createImageBitmap=undefined;";
try {
  driver = spawn(driverArg, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", resolve(edgeArg)], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, KINSHOKO_DATA_DIR: data, KINSHOKO_SKIP_AUTOSTART: "1", WEBVIEW2_USER_DATA_FOLDER: profile, APPDATA: join(work, "env-roaming"), LOCALAPPDATA: join(work, "env-local") } });
  await until("driver ready", () => fetch(endpoint + "/status").then((r) => r.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, webviewOptions: { userDataFolder: profile } } } } });
  base = "/session/" + session.sessionId; mainHandle = await wd("GET", base + "/window");
  await until("formal app ready", () => find(setting));
  report.browser = await exec("return {userAgent:navigator.userAgent,dpr:devicePixelRatio,width:innerWidth,height:innerHeight,screen:{width:screen.width,height:screen.height,colorDepth:screen.colorDepth},gamutP3:matchMedia('(color-gamut: p3)').matches,hdr:matchMedia('(dynamic-range: high)').matches}");
  const runtimeProcesses = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like ('*'+$env:KINSHOKO_T18_PROFILE+'*') } | ForEach-Object { @{pid=$_.ProcessId;path=$_.ExecutablePath;fileVersion=(Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.FileVersion} })"], { windowsHide: true, encoding: "utf8", env: { ...process.env, KINSHOKO_T18_PROFILE: profile } });
  if (runtimeProcesses.status !== 0) throw Error("Running WebView process facts: " + runtimeProcesses.stderr);
  report.runningWebviewProcesses = JSON.parse(runtimeProcesses.stdout);
  check(report.runningWebviewProcesses.length > 0, "actual isolated running WebView executable versions recorded separately from installed-version query");
  if (mode !== "pin-error") {
  await click(setting);
  await until("real current Runtime capability operations complete", () => exec("return document.querySelector('[aria-label=本机运行时]')?.textContent.includes('基础图片解码与钉图绘制检查完成。')"));
  check(!await exec("return Boolean(document.querySelector('[aria-label=运行时能力提示]'))"), "current Runtime has no required capability warning");
  await click(button("显示诊断信息"));
  report.currentDiagnostic = await until("real diagnostic report", () => exec("return document.querySelector('[aria-label=诊断信息]')?.textContent"));
  check(report.currentDiagnostic.includes("[运行时能力]") && report.currentDiagnostic.includes("不代表色彩门槛通过"), "current report binds operations without declaring colour correctness");
  reportPrivacy(report.currentDiagnostic);
  await screenshot("runtime-current.png");
  check((await diagnosticFile("runtime-current.txt")).includes("内置 PNG 解码：完成"), "formal native export retains current measured capabilities");
  await click(button("关闭设置"));
  }
  const library = await invoke("plugin:library|create_library", { parent, name: "T18 Runtime Reference" });
  const task = await invoke("plugin:library|start_import", { libraryId: library.id, source: { paths: [sampleFile] }, destination: { libraryId: library.id, folderId: null } });
  await until("real import complete", async () => (await invoke("plugin:library|import_tasks")).find((entry) => entry.taskId === task && entry.report && !entry.finishing));
  await exec("location.reload()"); await until("formal imported card", () => exec("return document.querySelector('.card img')?.complete && document.querySelector('.card img')?.naturalWidth > 0"));
  await click("//*[contains(@class,'card') and @data-id][1]");
  await until("representative original visible", () => exec("return document.querySelector('.viewer-stage img')?.complete && document.querySelector('.viewer-stage img')?.naturalWidth > 0"));
  if (mode !== "pin-error") {
  await click(button("原图像素"));
  report.originalDisplay = await until("original-sized reference", () => exec("const image=document.querySelector('.viewer-stage img');return image?.complete&&image.naturalWidth===400?{src:image.currentSrc,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight}:null"));
  await screenshot("representative-original.png"); check(true, "representative original is visible at original size in current Runtime");
  }
  if (mode === "full") {
  await click(button("钉住整图"));
  pinHandle = await until("native pin window", async () => (await wd("GET", base + "/window/handles")).find((handle) => handle !== mainHandle));
  await wd("POST", base + "/window", { handle: pinHandle });
  report.currentPinCanvas = await until("native pin canvas has drawn decoded source", pinCanvasSource);
  await until("pin native visibility and appearance feedback complete", async () => await exec("const feedback=document.querySelector('.pin-appear');return feedback&&getComputedStyle(feedback).opacity==='0'") && await invoke("plugin:window|is_visible", { label: await exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label") }));
  await screenshot("representative-pin.png"); pinScreenshotSamples("representative-pin.png"); check(true, "representative pin uses the production renderer and decoded source");
  const fallbackScript = "window.__T18_CONTROLLED_ABSENCE__='float16 and optional createImageBitmap in current Runtime';const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,options){if(kind==='2d'&&options?.colorType==='float16')throw new TypeError('controlled float16 absence');return original.apply(this,arguments)};window.createImageBitmap=undefined;";
  const fallbackScriptId = await injectNextDocument(fallbackScript);
  report.fallbackPinCanvas = await until("controlled fallback pin drew source", async () => { const canvas = await pinCanvasSource(); return canvas && canvas.attributes.colorType !== "float16" && !await exec("return Boolean(document.querySelector('[aria-label=运行时能力提示]'))") ? canvas : false; });
  await until("fallback pin appearance feedback complete", () => exec("const feedback=document.querySelector('.pin-appear');return feedback&&getComputedStyle(feedback).opacity==='0'"));
  await screenshot("controlled-float16-fallback-pin.png"); pinScreenshotSamples("controlled-float16-fallback-pin.png"); check(true, "controlled float16/createImageBitmap absence uses 8-bit pin without blocking display");
  await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: fallbackScriptId });
  await closeCurrentPin();
  initialPinProof = await initialHiddenPin({ application, profile, work, openPin: () => click(button("钉住整图")) });
  report.pinHiddenBeforeMissingCheck = initialPinProof.receipt.beforeResume;
  check(!report.pinHiddenBeforeMissingCheck.visible, "controlled missing canvas starts from a new production pin with actual native initial visibility false");
  pinHandle = await until("new controlled native pin window", async () => (await wd("GET", base + "/window/handles")).find((handle) => handle !== mainHandle));
  await wd("POST", base + "/window", { handle: pinHandle });
  await until("initial controlled pin script applied", () => exec("return window.__T18_CONTROLLED_ABSENCE__==='canvas2d unavailable in current Runtime'"));
  await until("actual missing canvas pin reason visible", () => exec("return document.querySelector('[role=alert]')?.textContent.includes('无法建立二维画布，钉图无法显示')"));
  const pinLabel = await exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label");
  report.missingCanvasPin = { label: pinLabel, visible: false, message: await exec("return document.querySelector('[role=alert]').textContent"), productionCanvasPresent: await exec("return Boolean(document.querySelector('.pin-canvas'))"), visibilityObservations: [] };
  if (report.missingCanvasPin.productionCanvasPresent) throw Error("Controlled initial canvas-absence precondition failed: production canvas already exists");
  const visibilityStarted = Date.now();
  // React can commit the error before the production pinReady IPC finishes showing the window.
  // Observe its actual native result; never invoke ready/show from this harness to make it pass.
  await until("production missing-canvas pin ready makes the native window visible", async () => {
    const visible = await invoke("plugin:window|is_visible", { label: pinLabel });
    report.missingCanvasPin.visibilityObservations.push({ elapsedMs: Date.now() - visibilityStarted, visible });
    report.missingCanvasPin.visible = visible;
    return visible && await exec("return document.querySelector('[role=alert]')?.textContent.includes('无法建立二维画布，钉图无法显示')");
  }, 5000);
  report.missingCanvasPin.readyTrace = await exec("return {installed:window.__T18_READY_TRACE_INSTALLED__,timeOrigin:performance.timeOrigin,events:window.__T18_READY_OBSERVATIONS__}");
  report.missingCanvasPin.nativeAfterReady = inspectNativePin(application);
  check(report.missingCanvasPin.nativeAfterReady.hwnd === report.pinHiddenBeforeMissingCheck.hwnd && report.missingCanvasPin.nativeAfterReady.visible, "same initially hidden native HWND is visible after the production ready path");
  check(report.missingCanvasPin.visible, "controlled required canvas absence shows native pin error instead of silent hiding");
  await screenshot("controlled-required-canvas-pin.png");
  await initialPinProof.close();
  await closeCurrentPin();
  }
  if (mode === "pin-error") {
    // Establish a normal production pin only as a precondition. This scope does not repeat its full display checks.
    await click(button("钉住整图"));
    pinHandle = await until("owned production pin precondition", async () => (await wd("GET", base + "/window/handles")).find((handle) => handle !== mainHandle));
    await wd("POST", base + "/window", { handle: pinHandle });
    await until("production pin ready precondition", async () => await pinCanvasSource() && await invoke("plugin:window|is_visible", { label: await exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label") }));
    const label = await exec("return window.__TAURI_INTERNALS__.metadata.currentWindow.label");
    const beforeHide = inspectNativePin(application);
    if (!beforeHide.visible) throw Error("Framework-hide precondition requires the actual owned native pin to be visible");
    await invoke("plugin:window|hide", { label });
    const afterHide = inspectNativePin(application);
    const tauriHidden = !await invoke("plugin:window|is_visible", { label });
    report.frameworkHide = { label, beforeHide, afterHide, tauriHidden };
    check(beforeHide.hwnd === afterHide.hwnd && !afterHide.visible && tauriHidden, "public Tauri hide synchronizes the same owned HWND and framework visibility to false");
    await injectNextDocument("window.__T18_CONTROLLED_ABSENCE__='canvas2d unavailable after framework hide in current Runtime';const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind){return kind==='2d'?null:original.apply(this,arguments)};");
    await until("controlled required-canvas error after framework hide", () => exec("return document.querySelector('[role=alert]')?.textContent.includes('无法建立二维画布，钉图无法显示')"));
    report.missingCanvasPin = { label, message: await exec("return document.querySelector('[role=alert]').textContent"), productionCanvasPresent: await exec("return Boolean(document.querySelector('.pin-canvas'))"), visibilityObservations: [] };
    check(!report.missingCanvasPin.productionCanvasPresent, "controlled missing-canvas pin has its specific reason and no production canvas");
    const started = Date.now();
    await until("production ready shows framework-hidden pin error", async () => {
      const visible = await invoke("plugin:window|is_visible", { label });
      report.missingCanvasPin.visibilityObservations.push({ elapsedMs: Date.now() - started, visible });
      return visible;
    }, 5000);
    const afterReady = inspectNativePin(application);
    report.missingCanvasPin.nativeAfterReady = afterReady;
    check(afterReady.hwnd === beforeHide.hwnd && afterReady.visible, "production ready shows the same framework-hidden native HWND with its capability error");
    await until("pin error appearance feedback complete", () => exec("const feedback=document.querySelector('.pin-appear');return feedback&&getComputedStyle(feedback).opacity==='0'"));
    await screenshot("framework-hidden-required-canvas-pin.png");
    await closeCurrentPin();
  } else {
  await click(button("返回图片墙")); await click(setting);
  await exec(mainFaultScript);
  await click(`${details}//button[normalize-space()='重新检查运行时']`);
  await until("current Runtime fallback status", () => exec("return document.querySelector('[aria-label=本机运行时]')?.textContent.includes('钉图使用 8 位画布降级')"));
  check(!await exec("return Boolean(document.querySelector('[aria-label=运行时能力提示]'))"), "controlled optional absence does not warn that ordinary browsing is blocked");
  await screenshot("controlled-fallback-details.png");
  await exec("HTMLCanvasElement.prototype.getContext=function(kind){return kind==='2d'?null:window.__T18_ORIGINAL_CONTEXT__.apply(this,arguments)}");
  await click(`${details}//button[normalize-space()='重新检查运行时']`);
  await until("main required capability reason", () => exec("return document.querySelector('[aria-label=运行时能力提示] [role=alert]')?.textContent.includes('无法建立二维画布，钉图无法显示')"));
  await click("//aside[@aria-label='运行时能力提示']//button[normalize-space()='打开微软 WebView2 下载页']");
  await delay(500);
  check(!await exec("return document.querySelector('[aria-label=运行时能力提示]')?.textContent.includes('无法打开微软')"), "formal fixed Microsoft download action reports no launch failure");
  await screenshot("controlled-required-canvas-main.png");
  const missingReport = await diagnosticFile("controlled-required-canvas.txt", "//aside[@aria-label='运行时能力提示']");
  check(missingReport.includes("无法建立二维画布，钉图无法显示"), "exported local report preserves actual required capability failure reason");
  await exec("HTMLCanvasElement.prototype.getContext=window.__T18_ORIGINAL_CONTEXT__;window.createImageBitmap=window.__T18_ORIGINAL_BITMAP__;window.__T18_ORIGINAL_DECODE__=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=undefined");
  await click(`${details}//button[normalize-space()='重新检查运行时']`);
  await until("missing decode API actual reason", () => exec("return document.querySelector('[aria-label=运行时能力提示]')?.textContent.includes('缺少图片解码接口（HTMLImageElement.decode）')"));
  await screenshot("controlled-required-decode-main.png"); check(true, "controlled missing decode API has its specific reason");
  await exec("HTMLImageElement.prototype.decode=window.__T18_ORIGINAL_DECODE__");
  await click(`${details}//button[normalize-space()='重新检查运行时']`);
  await until("current Runtime recovered after controlled absence", () => exec("return document.querySelector('[aria-label=本机运行时]')?.textContent.includes('基础图片解码与钉图绘制检查完成。')&&!document.querySelector('[aria-label=运行时能力提示]')"));
  await screenshot("runtime-recovered.png");
  }
  check(hash(readFileSync(sampleFile)) === originalHash, "runtime checks and diagnostics preserve original file bytes");
  report.knownFolder.existedAfter = existsSync(knownFolderConfig);
  if (report.knownFolder.existedAfter) report.knownFolder.settingsSha256 = hash(readFileSync(knownFolderConfig));
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = String(error); process.exitCode = 1;
  if (initialPinProof && base) report.initialPinFailureTrace = await exec("return {installed:window.__T18_READY_TRACE_INSTALLED__,timeOrigin:performance.timeOrigin,events:window.__T18_READY_OBSERVATIONS__}").catch(() => null);
  if (base) { await screenshot("failure.png").catch(() => {}); report.failurePage = await exec("return {url:location.href,text:document.body.innerText}").catch(() => null); }
  console.error(error);
} finally {
  if (initialPinProof) await initialPinProof.close();
  if (base) await wd("DELETE", base).catch(() => {});
  // Own frozen executable only. No other task/user process is touched.
  const cleanup = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T18_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { windowsHide: true, encoding: "utf8", env: { ...process.env, KINSHOKO_T18_EXECUTABLE: application } });
  report.cleanupCommand = { status: cleanup.status, stderr: cleanup.stderr };
  if (driver?.pid) { driver.kill(); await delay(800); }
  const inventory = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T18_EXECUTABLE -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like ('*'+$env:KINSHOKO_T18_PROFILE+'*')) -or ($_.Name -in @('tauri-driver.exe','msedgedriver.exe') -and $_.CommandLine -match '(4618|4619)') } | Select-Object ProcessId,Name,ExecutablePath,CommandLine) -Depth 4"], { windowsHide: true, encoding: "utf8", env: { ...process.env, KINSHOKO_T18_EXECUTABLE: application, KINSHOKO_T18_PROFILE: profile } });
  report.cleanupInventory = inventory.stdout.trim(); report.cleanupInventoryError = inventory.stderr;
  if (inventory.status !== 0 || JSON.parse(report.cleanupInventory).length !== 0) {
    report.status = "failed"; process.exitCode = 1; report.cleanupFailure = "Owned process inventory was not empty; KnownFolder retained";
  } else {
    report.knownFolder.existedAfterRun = existsSync(knownFolderConfig);
    if (report.knownFolder.existedAfterRun) {
      report.knownFolder.settingsSha256 = hash(readFileSync(knownFolderConfig));
      report.knownFolder.archivedTo = join(work, "known-folder-settings.json");
      copyFileSync(knownFolderConfig, report.knownFolder.archivedTo);
      unlinkSync(knownFolderConfig);
    }
    report.knownFolder.existsAfterCleanup = existsSync(knownFolderConfig);
  }
  writeFileSync(join(work, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, work, checks: report.checks.length, source: report.source, tree: report.tree, binarySha256: report.binarySha256, cleanup: report.cleanupInventory }));
}
