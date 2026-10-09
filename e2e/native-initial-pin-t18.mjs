// Controlled current-Runtime canvas absence before a new production pin's first script runs.
// Browser CDP is connected only after its listening PID is proved to own this run's profile.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fault = `
if(new URLSearchParams(location.search).get('view')==='pin'){
  window.__T18_CONTROLLED_ABSENCE__='canvas2d unavailable in current Runtime';
  window.__T18_READY_OBSERVATIONS__=[];
  window.addEventListener('unhandledrejection',event=>window.__T18_READY_OBSERVATIONS__.push({kind:'unhandledrejection',at:performance.now(),reason:String(event.reason)}));
  // IPC is observed passively through CDP Network. The frozen Tauri bridge is not replaced.
  window.__T18_READY_TRACE_INSTALLED__='passive CDP Network; postMessage fallback is not observable here';
  const context=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(kind){if(kind==='2d'){window.__T18_READY_OBSERVATIONS__.push({kind:'controlledCanvasNull',at:performance.now()});return null}return context.apply(this,arguments)};
}`;

const ownershipScript = String.raw`
$ErrorActionPreference='Stop'
$taskProcesses=Get-CimInstance Win32_Process
$taskApp=@($taskProcesses | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T18_EXECUTABLE })
if($taskApp.Count -ne 1){throw 'One exact frozen app process required'}
$taskBrowser=@($taskProcesses | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like ('*'+$env:KINSHOKO_T18_PROFILE+'*') -and $_.CommandLine -notmatch '--type=' })
if($taskBrowser.Count -ne 1){throw 'One exact-profile browser process required'}
$taskAncestor=$taskBrowser[0].ParentProcessId
$taskOwnsBrowser=$false
for($taskDepth=0;$taskDepth -lt 8;$taskDepth++){
  if($taskAncestor -eq $taskApp[0].ProcessId){$taskOwnsBrowser=$true;break}
  $taskParent=@($taskProcesses | Where-Object { $_.ProcessId -eq $taskAncestor })
  if($taskParent.Count -ne 1){break}
  $taskAncestor=$taskParent[0].ParentProcessId
}
if(!$taskOwnsBrowser){throw 'Exact frozen app is not an ancestor of profile browser'}
$taskPorts=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq [int]$env:KINSHOKO_T18_DEVTOOLS_PORT })
if(!$taskPorts.Count -or @($taskPorts | Where-Object {$_.OwningProcess -ne $taskBrowser[0].ProcessId}).Count){throw 'DevTools listener is not owned by exact-profile browser'}
ConvertTo-Json -InputObject @{appPid=$taskApp[0].ProcessId;browserPid=$taskBrowser[0].ProcessId;port=[int]$env:KINSHOKO_T18_DEVTOOLS_PORT;profile=$env:KINSHOKO_T18_PROFILE;browserPath=$taskBrowser[0].ExecutablePath}
`;

export function inspectNativePin(application) {
  const inspected = spawnSync("python", ["e2e/native-pin-inspect-t18.py", application], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  if (inspected.status !== 0) throw Error("Owned native pin inspection: " + inspected.stderr);
  return JSON.parse(inspected.stdout);
}

export async function initialHiddenPin({ application, profile, work, openPin }) {
  const receipt = { kind: "controlled canvas absence in a new production pin", events: [], commands: [], readyNetwork: [], faultSource: fault };
  let socket, sequence = 0, closed = false;
  const pending = new Map();
  const readyRequests = new Map();
  const save = () => writeFileSync(join(work, "initial-hidden-pin-cdp.json"), JSON.stringify(receipt, null, 2) + "\n");
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Owned browser CDP timeout: " + method)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    receipt.commands.push({ id, method, sessionId: sessionId ?? null, at: Date.now() });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const wait = async (read, label) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise((done) => setTimeout(done, 50)); }
    throw Error("Owned initial pin CDP precondition: " + label);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    if (socket?.readyState === WebSocket.OPEN) {
      await send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch((error) => { receipt.detachFailure = String(error); });
    }
    socket?.close();
    save();
  };
  try {
    const portFile = join(profile, "EBWebView", "DevToolsActivePort");
    const [portText, browserPath] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    if (!/^\d+$/.test(portText) || !/^\/devtools\/browser\/[\w-]+$/.test(browserPath)) throw Error("Malformed owned DevToolsActivePort");
    const port = Number(portText);
    const ownership = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ownershipScript], { windowsHide: true, encoding: "utf8", timeout: 15000, env: { ...process.env, KINSHOKO_T18_EXECUTABLE: application, KINSHOKO_T18_PROFILE: profile, KINSHOKO_T18_DEVTOOLS_PORT: portText } });
    if (ownership.status !== 0) throw Error("Owned DevTools listener check: " + ownership.stderr);
    receipt.ownership = JSON.parse(ownership.stdout);
    socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(event.data);
      if (value.id) {
        const request = pending.get(value.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(value.id);
        if (value.error) { receipt.commands.find((command) => command.id === value.id).error = value.error; request.reject(Error(JSON.stringify(value.error))); }
        else request.resolve(value.result);
      } else if (value.method?.startsWith("Target.") || value.method === "Runtime.exceptionThrown") {
        receipt.events.push({ ...value, observedAt: Date.now() });
      } else if (value.method === "Network.requestWillBeSent") {
        const request = value.params;
        const url = new URL(request.request.url);
        const command = decodeURIComponent(url.pathname).slice(1);
        if (url.hostname === "ipc.localhost" && ["plugin:desktop|pin_frame", "plugin:desktop|pin_ready"].includes(command)) {
          readyRequests.set(request.requestId, command);
          // Never retain IPC headers, invocation keys, request payloads, or unrelated network traffic.
          receipt.readyNetwork.push({ kind: "request", command, requestId: request.requestId, timestamp: request.timestamp, wallTime: request.wallTime, observedAt: Date.now() });
        }
      } else if (value.method === "Network.responseReceived" && readyRequests.has(value.params.requestId)) {
        const response = value.params.response;
        const responseMarker = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "tauri-response")?.[1];
        receipt.readyNetwork.push({ kind: "response", command: readyRequests.get(value.params.requestId), requestId: value.params.requestId, timestamp: value.params.timestamp, status: response.status, responseMarker, observedAt: Date.now() });
      } else if (["Network.loadingFinished", "Network.loadingFailed"].includes(value.method) && readyRequests.has(value.params.requestId)) {
        receipt.readyNetwork.push({ kind: value.method, command: readyRequests.get(value.params.requestId), requestId: value.params.requestId, timestamp: value.params.timestamp, observedAt: Date.now() });
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Owned browser CDP open timeout")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser CDP open failed")); }, { once: true });
    });
    receipt.targetsBefore = (await send("Target.getTargets")).targetInfos;
    const knownTargets = new Set(receipt.targetsBefore.map((target) => target.targetId));
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page", exclude: false }, { exclude: true }] });
    await openPin();
    const attached = await wait(() => receipt.events.find((event) => event.method === "Target.attachedToTarget" && event.params.waitingForDebugger && !knownTargets.has(event.params.targetInfo.targetId)), "new owned pin did not attach paused; support unverified");
    const sessionId = attached.params.sessionId, targetId = attached.params.targetInfo.targetId;
    receipt.targetUrlObservations = [];
    receipt.pausedTarget = await wait(async () => {
      const target = (await send("Target.getTargetInfo", { targetId })).targetInfo;
      receipt.targetUrlObservations.push({ url: target.url, at: Date.now() });
      return target.url.includes("view=pin") && target.url.includes("pin=") ? target : false;
    }, "new paused target did not acquire the owned production pin URL");
    await send("Runtime.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);
    receipt.preload = await send("Page.addScriptToEvaluateOnNewDocument", { source: fault, runImmediately: true }, sessionId);
    receipt.beforeResumeContext = await send("Runtime.evaluate", { expression: "({url:location.href,controlledAbsence:window.__T18_CONTROLLED_ABSENCE__,traceInstalled:window.__T18_READY_TRACE_INSTALLED__,timeOrigin:performance.timeOrigin})", returnByValue: true }, sessionId);
    receipt.beforeResume = inspectNativePin(application);
    if (receipt.beforeResume.visible) throw Error("New production pin was not natively hidden before first script");
    receipt.resumedAt = Date.now();
    await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    save();
    return { receipt, close };
  } catch (error) {
    receipt.failure = String(error);
    await close();
    throw error;
  }
}
