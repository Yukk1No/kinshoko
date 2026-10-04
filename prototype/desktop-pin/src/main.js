// PROTOTYPE for #7, round 2. One page, three modes:
//   ?pin=<id>   a pinned image
//   ?capture=1  the frozen-screen region selector (F1)
//   otherwise   the control window (capture history, prototype library, status)
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

const params = new URLSearchParams(location.search);
const app = document.getElementById("app");

const urlFor = (src) => (src.startsWith("/samples/") ? src : convertFileSrc(src));
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`无法读取 ${src}`));
    img.src = urlFor(src);
  });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

if (params.get("pin")) pinView(params.get("pin"));
else if (params.get("capture")) captureView();
else controlView();

// ---------------------------------------------------------------- pin window

async function pinView(id) {
  document.body.classList.add("pin");
  app.innerHTML = `
    <canvas id="c"></canvas>
    <div class="bar">
      <button data-act="fav" title="收藏到资料库">★</button>
      <button data-act="flipH" title="水平翻转 H">⇋</button>
      <button data-act="flipV" title="垂直翻转 V">⇵</button>
      <button data-act="rotate" title="顺时针旋转 90° R">⟳</button>
      <button data-act="locked" title="锁定：禁止移动和缩放">锁</button>
      <button data-act="onTop" title="置顶">顶</button>
      <button data-act="close" title="关闭钉图">✕</button>
    </div>
    <div class="badge"></div>`;
  const canvas = app.querySelector("#c");
  const badge = app.querySelector(".badge");
  let pin = null;
  let img = null;
  let badgeTimer = 0;

  const draw = () => {
    if (!pin || !img) return;
    const dpr = window.devicePixelRatio;
    // Size from the pin's physical size, not innerWidth (whole CSS px), and keep CSS size =
    // device px / dpr: anything else is resampled at 110% (found twice by probe_windows.py).
    const odd0 = pin.rotation % 2 === 1;
    const W = Math.max(1, Math.round((odd0 ? pin.h : pin.w) * pin.scale));
    const H = Math.max(1, Math.round((odd0 ? pin.w : pin.h) * pin.scale));
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W / dpr}px`;
    canvas.style.height = `${H / dpr}px`;
    canvas.style.opacity = pin.opacity;
    // At 100% flips and quarter turns are pixel permutations: show them without smoothing.
    canvas.style.imageRendering = Math.abs(pin.scale - 1) < 1e-9 ? "pixelated" : "auto";
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.translate(W / 2, H / 2);
    ctx.rotate((pin.rotation * Math.PI) / 2);
    ctx.scale(pin.flipH ? -1 : 1, pin.flipV ? -1 : 1);
    const odd = pin.rotation % 2 === 1;
    const dw = odd ? H : W;
    const dh = odd ? W : H;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  };

  const flashBadge = (text) => {
    badge.textContent = text;
    badge.classList.add("show");
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.classList.remove("show"), 900);
  };

  const applyState = (s) => {
    const next = s.pins.find((p) => p.id === id);
    if (!next) return;
    const redraw = !pin || ["flipH", "flipV", "rotation", "opacity", "scale"].some((k) => pin[k] !== next[k]);
    pin = next;
    for (const b of app.querySelectorAll(".bar button[data-act]")) {
      const act = b.dataset.act;
      if (act in pin) b.classList.toggle("on", !!pin[act]);
    }
    const item = s.history.find((h) => h.id === pin.captureId);
    const fav = app.querySelector('[data-act="fav"]');
    fav.classList.toggle("on", !!item?.libraryFile);
    fav.disabled = !item;
    fav.title = !item ? "不是截图，或已滚出截图历史" : item.libraryFile ? "已收藏" : "收藏到资料库";
    document.body.classList.toggle("locked", pin.locked);
    document.body.classList.toggle("hidden-edge", !!pin.hidden && !pin.hidden.peeking);
    if (redraw) draw();
  };

  const act = async (name) => {
    try {
      if (name === "close") return await invoke("close_pin", { id });
      if (name === "rotate") return await invoke("rotate", { id });
      if (name === "fav") return pin.captureId && (await invoke("favorite", { captureId: pin.captureId }));
      await invoke("set_flag", { id, flag: name, value: !pin[name] });
    } catch (e) {
      flashBadge(String(e));
    }
  };

  app.querySelector(".bar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) act(b.dataset.act);
  });

  // Drag to move. startDragging swallows dblclick, so detect double-click by hand.
  let lastDown = 0;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !pin) return;
    const now = performance.now();
    if (now - lastDown < 320) {
      lastDown = 0;
      if (!pin.locked) invoke("set_scale", { id, scale: 1, ax: 0.5, ay: 0.5 });
      flashBadge("100%");
      return;
    }
    lastDown = now;
    if (!pin.locked) getCurrentWindow().startDragging();
  });

  // Wheel: animated zoom around the cursor. Ctrl+wheel: opacity (Snipaste convention).
  let targetScale = null;
  let settleTimer = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!pin) return;
      if (e.ctrlKey) {
        const next = Math.round(Math.min(1, Math.max(0.1, pin.opacity + (e.deltaY < 0 ? 0.1 : -0.1))) * 10) / 10;
        invoke("set_opacity", { id, opacity: next });
        flashBadge(`不透明度 ${Math.round(next * 100)}%`);
        return;
      }
      if (pin.locked) return flashBadge("已锁定");
      targetScale = (targetScale ?? pin.scale) * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => (targetScale = null), 300);
      invoke("set_scale", { id, scale: targetScale, ax: e.clientX / innerWidth, ay: e.clientY / innerHeight });
      flashBadge(`${Math.round(targetScale * 100)}%`);
    },
    { passive: false },
  );
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault(); // no browser zoom
    if (e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "h") act("flipH");
    else if (k === "v") act("flipV");
    else if (k === "r") act("rotate");
  });
  // While the window animates (zoom/rotate), stretch the canvas to follow it smoothly;
  // once it settles, snap back to the exact device-pixel size.
  let settle = 0;
  new ResizeObserver(() => {
    Object.assign(canvas.style, { width: "100vw", height: "100vh" });
    clearTimeout(settle);
    settle = setTimeout(draw, 160);
  }).observe(document.documentElement);

  await listen("state-changed", (e) => applyState(e.payload));
  const first = await invoke("get_state");
  const p = first.pins.find((x) => x.id === id);
  if (!p) return;
  try {
    img = await loadImage(p.src);
  } catch {
    flashBadge(`原图缺失：${p.src}`);
  }
  applyState(first);
  draw();
}

// ---------------------------------------------------------------- capture overlay

async function captureView() {
  document.body.classList.add("capture");
  app.innerHTML = `
    <img id="shot" alt="" />
    <div id="shade"></div>
    <div id="sel" hidden><span id="dim"></span></div>
    <div id="tools" hidden>
      <button data-a="pin" class="primary" title="Enter / F3 / 双击">钉住</button>
      <button data-a="copy" title="Ctrl+C">复制</button>
      <button data-a="cancel" title="Esc / 右键">取消</button>
    </div>
    <div id="tip">拖动框选区域 · Enter 钉住 · Ctrl+C 复制 · Esc 取消</div>`;
  const info = await invoke("capture_info");
  if (!info) return invoke("capture_cancel");
  const shot = app.querySelector("#shot");
  const sel = app.querySelector("#sel");
  const dim = app.querySelector("#dim");
  const tools = app.querySelector("#tools");
  const dpr = window.devicePixelRatio;
  // Physical px of the screenshot = CSS px * dpr: the frozen screen sits exactly in place.
  Object.assign(shot.style, { width: `${info.w / dpr}px`, height: `${info.h / dpr}px` });
  shot.onload = () => invoke("capture_ready");
  shot.src = `${convertFileSrc(info.file)}?t=${Date.now()}`;

  let start = null;
  let rect = null; // physical px, relative to the monitor
  // Pointer events carry fractional CSS coordinates, so clientX * dpr lands on the exact
  // physical pixel even at 110% (mouse events snap to whole CSS px, ±1 physical px off).
  const toPx = (e) => ({ x: Math.round(e.clientX * dpr), y: Math.round(e.clientY * dpr) });
  const setRect = (a, b) => {
    rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    Object.assign(sel.style, {
      left: `${rect.x / dpr}px`,
      top: `${rect.y / dpr}px`,
      width: `${rect.w / dpr}px`,
      height: `${rect.h / dpr}px`,
    });
    sel.hidden = false;
    document.body.classList.add("has-sel");
    dim.textContent = `${rect.w} × ${rect.h}`;
  };
  const finish = (action) => {
    if (action === "cancel") return invoke("capture_cancel");
    if (!rect || rect.w < 4 || rect.h < 4) return;
    invoke("capture_finish", { ...rect, action });
  };
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#tools")) return;
    if (e.button === 2) return finish("cancel");
    if (e.button !== 0) return;
    document.documentElement.setPointerCapture(e.pointerId);
    start = toPx(e);
    tools.hidden = true;
  });
  document.addEventListener("pointermove", (e) => {
    if (start) setRect(start, toPx(e));
  });
  document.addEventListener("pointerup", (e) => {
    if (!start) return;
    setRect(start, toPx(e));
    start = null;
    if (rect.w < 4 || rect.h < 4) return;
    Object.assign(tools.style, {
      left: `${Math.max(4, Math.min(innerWidth - 200, (rect.x + rect.w) / dpr - 190))}px`,
      top: `${Math.min(innerHeight - 40, (rect.y + rect.h) / dpr + 8)}px`,
    });
    tools.hidden = false;
  });
  document.addEventListener("dblclick", () => finish("pin"));
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  tools.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-a]");
    if (b) finish(b.dataset.a);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") finish("cancel");
    else if (e.key === "Enter" || e.key === "F3") finish("pin");
    else if (e.ctrlKey && e.key.toLowerCase() === "c") finish("copy");
  });
}

// ---------------------------------------------------------------- control window

async function controlView() {
  document.body.classList.add("control");
  app.innerHTML = `
    <header>
      <h1>钉图原型 <small>PROTOTYPE · #7 第二轮</small></h1>
      <div class="actions">
        <button id="capture" class="primary">截图钉住 <kbd data-key="capture"></kbd></button>
        <button id="clip">钉剪贴板 <kbd data-key="pinClipboard"></kbd></button>
        <button id="hide">隐藏／显示全部 <kbd data-key="hide"></kbd></button>
        <button id="openFile">打开图片钉住…</button>
      </div>
    </header>
    <nav>
      <button data-tab="history" class="on">截图历史</button>
      <button data-tab="library">资料库（原型）</button>
      <button data-tab="status">状态</button>
    </nav>
    <section data-panel="history"><div class="grid" id="history"></div></section>
    <section data-panel="library" hidden><div class="grid" id="library"></div></section>
    <section data-panel="status" hidden>
      <h2>全局快捷键</h2>
      <div id="keys"></div>
      <h2>钉图</h2>
      <table id="pins"><thead><tr><th>id</th><th>原图</th><th>缩放</th><th>旋转／翻转</th><th>不透明度</th><th>位置</th><th>状态</th></tr></thead><tbody></tbody></table>
      <label><input type="checkbox" id="logging" /> 使用日志记录到本地文件（默认关）</label>
      <p class="hint" id="dataDir"></p>
      <details><summary>事件</summary><pre id="events"></pre></details>
    </section>`;
  const $ = (s) => app.querySelector(s);

  for (const b of app.querySelectorAll("nav button")) {
    b.onclick = () => {
      for (const x of app.querySelectorAll("nav button")) x.classList.toggle("on", x === b);
      for (const p of app.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== b.dataset.tab;
    };
  }
  $("#capture").onclick = () => invoke("start_capture_cmd");
  $("#clip").onclick = () => invoke("pin_clipboard_cmd");
  $("#hide").onclick = () => invoke("toggle_hide");
  $("#openFile").onclick = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (path) invoke("pin_file", { path }).catch((e) => alert(e));
  };
  $("#logging").onchange = (e) => invoke("set_logging", { on: e.target.checked });

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-do]");
    if (!b) return;
    const { do: what, path, cid, action } = b.dataset;
    if (what === "pin") invoke("pin_file", { path, captureId: cid || null }).catch((err) => alert(err));
    if (what === "fav") invoke("favorite", { captureId: cid }).catch((err) => alert(err));
    if (what === "key") {
      const v = prompt("新的全局快捷键（例如 F6、Ctrl+Alt+A）");
      if (v) invoke("change_key", { action, accelerator: v.trim() });
    }
  });

  const time = (ms) => new Date(ms).toLocaleTimeString();
  let lastHistory = "";
  let lastLibrary = "";
  function render(s) {
    for (const k of app.querySelectorAll("kbd[data-key]")) k.textContent = s.keys[k.dataset.key] ?? "未注册";
    $("#hide").classList.toggle("on", s.allHidden);

    const h = JSON.stringify(s.history);
    if (h !== lastHistory) {
      lastHistory = h;
      $("#history").innerHTML =
        s.history
          .map(
            (it) => `<figure>
          <img src="${urlFor(it.file)}" alt="" loading="lazy" />
          <figcaption>${time(it.created)} · ${it.w}×${it.h}</figcaption>
          <div class="row">
            <button data-do="pin" data-path="${esc(it.file)}" data-cid="${it.id}">钉住</button>
            <button data-do="fav" data-cid="${it.id}" ${it.libraryFile ? "disabled" : ""}>${it.libraryFile ? "★ 已收藏" : "☆ 收藏"}</button>
          </div></figure>`,
          )
          .join("") ||
        `<p class="hint">还没有截图。按 ${s.keys.capture ?? "截图键"} 框选屏幕上任意区域。最多保留 10 张，旧的会自动删除；收藏的会复制进资料库。</p>`;
    }
    const l = JSON.stringify(s.library);
    if (l !== lastLibrary) {
      lastLibrary = l;
      $("#library").innerHTML =
        s.library
          .map(
            (f) => `<figure>
          <img src="${urlFor(f)}" alt="" loading="lazy" />
          <figcaption>${esc(f.split(/[\\/]/).pop())}</figcaption>
          <div class="row"><button data-do="pin" data-path="${esc(f)}">钉住</button></div></figure>`,
          )
          .join("") || `<p class="hint">收藏的截图会出现在这里（原型用的临时文件夹，不是正式资料库）。</p>`;
    }

    $("#keys").innerHTML = [
      ["capture", "截图钉住"],
      ["pinClipboard", "钉剪贴板图片"],
      ["hide", "隐藏／显示全部钉图"],
    ]
      .map(
        ([a, label]) => `<div class="row keyrow"><span>${label}</span>
        ${s.keys[a] ? `<kbd>${s.keys[a]}</kbd>` : `<span class="warn">未注册：${esc(s.keyErrors[a] ?? "")}</span>`}
        <button data-do="key" data-action="${a}">更换</button></div>`,
      )
      .join("");
    $("#pins tbody").innerHTML =
      s.pins
        .map(
          (p) => `<tr><td>${p.id}</td><td>${p.w}×${p.h}</td><td>${Math.round(p.scale * 100)}%</td>
        <td>${p.rotation * 90}°${p.flipH ? " ⇋" : ""}${p.flipV ? " ⇵" : ""}</td><td>${Math.round(p.opacity * 100)}%</td>
        <td>${p.x},${p.y}</td><td>${[p.onTop ? "置顶" : "", p.locked ? "锁定" : "", p.hidden ? (p.hidden.peeking ? "探出" : `贴边:${p.hidden.edge}`) : ""].filter(Boolean).join(" · ")}</td></tr>`,
        )
        .join("") || `<tr><td colspan="7" class="hint">还没有钉图</td></tr>`;
    $("#logging").checked = s.logToFile;
    $("#dataDir").textContent = `数据目录：${s.dataDir}`;
    $("#events").textContent = s.events.slice().reverse().join("\n");
  }

  await listen("state-changed", (e) => render(e.payload));
  render(await invoke("get_state"));
}
