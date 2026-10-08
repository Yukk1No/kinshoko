// Same generated samples and CSS viewport as e2e/spec78-frontend.mjs, using the unchanged accepted prototype.
// Usage: node e2e/spec78-prototype.mjs <msedgedriver.exe> [evidence-directory]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
const [, , driverArg, outputArg = "docs/implementation/evidence/spec78-t01"] = process.argv;
if (!driverArg) throw new Error("Usage: node e2e/spec78-prototype.mjs <msedgedriver.exe> [evidence-directory]");
const output = resolve(outputArg);
const formal = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "kinshoko-spec78-prototype-"));
const port = 4470;
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4180", "--strictPort"], { cwd: resolve("prototype/reference-browser"), windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
const driver = spawn(resolve(driverArg), ["--port=" + port], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
const DRIVER = "http://127.0.0.1:" + port;
let base;
async function wd(method, path, body) {
  const response = await fetch(DRIVER + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const json = await response.json();
  if (!response.ok || json.value?.error) throw new Error(JSON.stringify(json));
  return json.value;
}
const exec = (script, args = []) => wd("POST", base + "/execute/sync", { script, args });
const until = async (label, read) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) { try { const result = await read(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("Timeout: " + label);
};
const check = (ok, label) => { if (!ok) throw new Error(label); console.log("✓ " + label); };
try {
  await until("prototype server", () => fetch("http://127.0.0.1:4180").then(r => r.ok));
  await until("driver", () => fetch(DRIVER + "/status").then(r => r.ok));
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "MicrosoftEdge", "ms:edgeOptions": { args: ["--headless=new", "--user-data-dir=" + join(work, "profile"), "--force-device-scale-factor=" + formal.viewport.dpr, "--window-size=1280,800"] } } } });
  base = "/session/" + session.sessionId;
  await wd("POST", base + "/url", { url: "http://127.0.0.1:4180" });
  const target = formal.viewport;
  for (let i = 0; i < 4; i++) {
    const now = await exec("return {width:innerWidth,height:innerHeight}");
    if (now.width === target.width && now.height === target.height) break;
    const outer = await wd("GET", base + "/window/rect");
    await wd("POST", base + "/window/rect", { width: outer.width + target.width - now.width, height: outer.height + target.height - now.height });
  }
  await until("same sample image decode", () => exec("return document.querySelectorAll('.card[data-id]').length > 0 && [...document.querySelectorAll('.card img')].every(i=>i.complete&&i.naturalWidth>0)"));
  const viewport = await exec("return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent}");
  check(viewport.width === target.width && viewport.height === target.height && viewport.dpr === target.dpr, "Prototype and formal app use the same CSS viewport and DPR");
  const fonts = await wd("POST", base + "/execute/async", { script: "const done=arguments[arguments.length-1];document.fonts.ready.then(()=>done([...document.fonts].filter(f=>f.status==='loaded').length>=4));", args: [] });
  check(fonts, "Accepted prototype uses the same shipped fonts offline");
  const sample = await exec("return document.querySelector('.card[data-id]').dataset.id");
  writeFileSync(join(output, "prototype-wall.png"), Buffer.from(await wd("GET", base + "/screenshot"), "base64"));
  const card = await exec("return document.querySelector('.card[data-id]')");
  const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
  await wd("POST", base + "/element/" + card[ELEMENT] + "/click", {});
  await until("single click viewer", () => exec("return !!document.querySelector('.viewer')"));
  writeFileSync(join(output, "prototype-viewer.png"), Buffer.from(await wd("GET", base + "/screenshot"), "base64"));
  await wd("POST", base + "/actions", { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE00C" }, { type: "keyUp", value: "\uE00C" }] }] });
  await until("return focus", () => exec("return !document.querySelector('.viewer') && document.activeElement?.dataset.id===arguments[0]", [sample]));
  check(true, "Unchanged accepted prototype single-clicks and returns focus to the same card");
  writeFileSync(join(output, "prototype-report.json"), JSON.stringify({ status: "passed", sourceCommit: "bd8aea44c4a311571ee3c07382cb7755f87f3153", viewport, fonts, samples: formal.samples, singleClickReturnFocus: true, humanAcceptance: "unverified" }, null, 2));
} finally {
  if (base) await wd("DELETE", base).catch(() => {});
  driver.kill(); vite.kill();
  await new Promise(r => setTimeout(r, 1000));
  const target = resolve(work);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("kinshoko-spec78-prototype-")) throw new Error("Invalid test cleanup target");
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
