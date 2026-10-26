// 经 CDP 读一个页面的 document.visibilityState，并数 1 秒内 requestAnimationFrame 回调次数（#275、#287）。
// 用法：node scripts/probe/page_frames.mjs <调试端口> <网址前缀> [网址里不能有的字]
// 输出一行 JSON：{"visibility": "visible", "frames": 171}。找不到页面时退出码 1。
// Edge 以 --remote-debugging-port 启动；Kinshoko 的 WebView2 用环境变量
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>。

const [port = "9339", prefix = "data:", exclude] = process.argv.slice(2);

// 页面整个卡住时 Runtime.evaluate 不回：10 秒后报卡在哪一步。
let step = "取页面列表";
setTimeout(() => {
  console.log(JSON.stringify({ visibility: "没有回应", frames: 0, step }));
  process.exit(0);
}, 10000).unref();

const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(
  (p) => p.type === "page" && p.url.startsWith(prefix) && !(exclude && p.url.includes(exclude)),
);
if (!page) {
  console.error(`没有以 ${prefix} 开头的页面：${pages.map((p) => p.url).join(" ")}`);
  process.exit(1);
}

step = `连接 ${page.url}`;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== 1) return;
  const v = msg.result?.result?.value ?? {};
  console.log(JSON.stringify({ visibility: v.visibility ?? "?", frames: v.frames ?? 0 }));
  ws.close();
};

const expression = `new Promise((resolve) => {
  let frames = 0;
  const start = performance.now();
  const done = () => resolve({ visibility: document.visibilityState, frames });
  const tick = () => {
    frames++;
    if (performance.now() - start < 1000) requestAnimationFrame(tick);
    else done();
  };
  // 页面停画时 rAF 不回调：2 秒后按数到的帧返回。
  setTimeout(done, 2000);
  requestAnimationFrame(tick);
})`;
step = `在 ${page.url} 里数帧`;
ws.send(
  JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }),
);
