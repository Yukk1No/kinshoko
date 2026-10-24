// 经 CDP 读最大化 Edge 页面的 document.visibilityState，并数 1 秒内 requestAnimationFrame 回调次数。
// 用法：node edge-frames.mjs <调试端口> [标签]
// Edge 要先以独立配置目录启动：msedge --user-data-dir=<临时目录> --remote-debugging-port=<端口> --start-maximized

const port = process.argv[2] ?? "9333";
const label = process.argv[3] ?? "";

const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.type === "page");
if (!page) throw new Error("没有页面");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const expression = `new Promise((resolve) => {
  let frames = 0;
  const start = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - start < 1000) requestAnimationFrame(tick);
    else resolve({ visibility: document.visibilityState, frames, hidden: document.hidden });
  };
  // 页面已隐藏时 rAF 不回调；2 秒后按 0 帧返回。
  setTimeout(() => resolve({ visibility: document.visibilityState, frames, hidden: document.hidden }), 2000);
  requestAnimationFrame(tick);
})`;
const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const v = res.result?.result?.value;
console.log(`${label}\tvisibilityState=${v?.visibility}\trAF/1s=${v?.frames}`);
ws.close();
