// One native scenario at a time, with new fixture paths and exact isolated settings restoration.
// Importing this module has no side effects. The CLI never ends an unowned process.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ownedWork, preserveKnownFolder, restoreKnownFolder } from "./spec78-combination-preflight.mjs";

const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const save = (root, name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2));
export function observeNative(port, profile, rootPid = 0) {
  const script = String.raw`
$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$native=@($all | Where-Object {
 $_.Name -match '^kinshoko.*\.exe$|^tauri-driver\.exe$|^msedgedriver\.exe$' -or
 ($_.Name -eq 'msedgewebview2.exe' -and ($_.CommandLine -match 'kinshoko|spec78' -or $_.CommandLine.Contains($env:KINSHOKO_STANDALONE_PROFILE))) -or
 ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'vite' -and $_.CommandLine -match 'kinshoko|spec78')
})
$owned=@{}; $rootPid=[uint32]$env:KINSHOKO_STANDALONE_PID
if($rootPid -gt 0){$owned[[string]$rootPid]=$true}
do {$added=$false; foreach($item in $all){if($owned.ContainsKey([string]$item.ParentProcessId) -and !$owned.ContainsKey([string]$item.ProcessId)){$owned[[string]$item.ProcessId]=$true;$added=$true}}}while($added)
function Record($item){@{pid=$item.ProcessId;parentPid=$item.ParentProcessId;executable=$item.ExecutablePath;created=$item.CreationDate.ToUniversalTime().ToString('o');commandLine=$item.CommandLine;descendant=$owned.ContainsKey([string]$item.ProcessId)}}
$ports=@([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -in [uint32]$env:KINSHOKO_STANDALONE_PORT,([uint32]$env:KINSHOKO_STANDALONE_PORT+1)} | ForEach-Object {@{address=[string]$_.Address;port=$_.Port}})
@{at=[DateTime]::UtcNow.ToString('o');processes=@($native | ForEach-Object {Record $_});lineage=@($all | Where-Object {$owned.ContainsKey([string]$_.ProcessId)} | ForEach-Object {Record $_});ports=$ports} | ConvertTo-Json -Compress -Depth 5
`;
  const query = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8", env: { ...process.env, KINSHOKO_STANDALONE_PORT: String(port), KINSHOKO_STANDALONE_PROFILE: profile, KINSHOKO_STANDALONE_PID: String(rootPid) } });
  if (query.status !== 0) throw Error("Native isolation observation failed: " + query.stderr);
  return JSON.parse(query.stdout.trim().replace(/^\uFEFF/, ""));
}

export async function runStandalone({work, script, args, port = 4640, environment = {}}) {
  work = ownedWork(work); script = resolve(script);
  if (existsSync(work)) throw Error("Keep each native run in a new directory");
  mkdirSync(work, { recursive: true });
  const scenario = join(work, "scenario"), output = join(work, "observations");
  const before = observeNative(port, scenario);
  save(work, "native-preflight.json", before);
  if (before.processes.length || before.ports.length) throw Error("Native desktop/ports/profile are occupied; preserve the other task and stop");
  const settings = preserveKnownFolder(work);
  if (settings.requested.exists || settings.resolved.exists) throw Error("Isolated T20 settings preexist; preserve them and stop before launching");
  const report = { script, args, scriptSha256: hash(script), port, scenario, output, startedAt: new Date().toISOString(), nativeDesktopGrant: "sole T20 lease assigned by coordinator", before, settings, observations: [] };
  const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...environment, KINSHOKO_STANDALONE_WORK: scenario, KINSHOKO_WEBDRIVER_PORT: String(port), KINSHOKO_VIEWER_OUTPUT: output, KINSHOKO_SKIP_AUTOSTART: "1" } });
  report.nodePid = child.pid;
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; process.stdout.write(data); });
  child.stderr.on("data", data => { stderr += data; process.stderr.write(data); });
  const completed = new Promise(done => { child.once("exit", (code, signal) => done({ code, signal })); child.once("error", error => done({ code: null, signal: null, error: String(error) })); });
  let timer;
  const observe = () => {
    try {
      const state = observeNative(port, scenario, child.pid);
      report.observations.push(state);
      if (state.processes.some(item => !item.descendant)) report.ownershipCollision = true;
      save(work, "wrapper.json", report);
    } catch (error) { report.observationError = String(error); }
  };
  observe();
  timer = setInterval(observe, 3000);
  const result = await completed;
  clearInterval(timer);
  Object.assign(report, { ...result, finishedAt: new Date().toISOString() });
  writeFileSync(join(work, "stdout.txt"), stdout); writeFileSync(join(work, "stderr.txt"), stderr);
  report.after = observeNative(port, scenario);
  report.released = !report.after.processes.length && !report.after.ports.length;
  if (report.released && !report.observationError && !report.ownershipCollision) report.restored = restoreKnownFolder(settings, work);
  else report.restored = { restored: false, reason: "Release/ownership observation is unconfirmed; preserve settings and all failed artifacts" };
  save(work, "wrapper.json", report);
  return report;
}

export function copyStandaloneRuntime(appArg, work, filename) {
  const app = resolve(appArg), application = join(work, filename), runtime = [];
  for (const name of readdirSync(dirname(app))) {
    if (name !== basename(app) && !name.toLowerCase().endsWith(".dll")) continue;
    const source = join(dirname(app), name), target = name === basename(app) ? application : join(work, name);
    copyFileSync(source, target);
    if (hash(source) !== hash(target)) throw Error("Runtime copy changed: " + name);
    runtime.push({ name, sha256: hash(target) });
  }
  save(work, "runtime-copy.json", runtime);
  return application;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""))) {
  const [work, script, ...args] = process.argv.slice(2);
  const report = await runStandalone({ work, script, args, port: Number(process.env.KINSHOKO_WEBDRIVER_PORT ?? 4640) });
  console.log(JSON.stringify({ exit: report.code, released: report.released, restored: report.restored?.restored }));
  process.exitCode = report.code === 0 && report.released && report.restored?.restored ? 0 : 1;
}
