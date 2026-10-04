// PROTOTYPE for #7. One page, two modes: `?pin=<id>` renders a pin window, otherwise the control window.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

const pinId = new URLSearchParams(location.search).get("pin");
const app = document.getElementById("app");

const SAMPLES = [
  { src: "/samples/pixel-grid.png", name: "像素网格（1px / 2px）" },
  { src: "/samples/line-study.png", name: "细线习作 1600×1200" },
  { src: "/samples/exif-orientation-6.jpg", name: "EXIF 方向 6（应显示 UP 朝上）" },
];

const urlFor = (src) => (src.startsWith("/samples/") ? src : convertFileSrc(src));
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`无法读取 ${src}`));
    img.src = urlFor(src);
  });

if (pinId) pinView(pinId);
else controlView();

// ---------------------------------------------------------------- pin window

async function pinView(id) {
  document.body.classList.add("pin");
  app.innerHTML = `
    <canvas id="c"></canvas>
    <div class="drag" data-tauri-drag-region></div>
    <div class="bar">
      <button data-act="onTop" title="置顶 Ctrl+Shift+A">置顶</button>
      <button data-act="locked" title="锁定 Ctrl+L：禁止移动和缩放">锁定</button>
      <button data-act="passthrough" title="穿透 Ctrl+T：笔和鼠标落到下面的画布">穿透</button>
      <button data-act="one" title="1:1 按键 1">1:1</button>
      <button data-act="close" title="关闭钉图">✕</button>
    </div>
    <div class="badge"></div>
    <pre class="diag" hidden></pre>`;
  const canvas = app.querySelector("#c");
  const drag = app.querySelector(".drag");
  const badge = app.querySelector(".badge");
  const diag = app.querySelector(".diag");
  let pin = null;
  let img = null;
  let info = null;
  let wasPassthrough = false;

  const draw = () => {
    if (!pin || !img) return;
    const w = Math.round(pin.crop.w * pin.scale);
    const h = Math.round(pin.crop.h * pin.scale);
    // Canvas backing store = intended physical size; CSS fills the window.
    // If the window's CSS*DPR differs from w×h the browser resamples; the diag shows it.
    canvas.width = w;
    canvas.height = h;
    // CSS size must map back to exactly w×h device pixels; `100vw` at 110% lands between
    // device pixels and the compositor resamples (found by scripts/probe_windows.py).
    const dpr = window.devicePixelRatio;
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;
    canvas.style.imageRendering = pin.scale === 1 ? "pixelated" : "auto";
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = pin.scale !== 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, pin.crop.x, pin.crop.y, pin.crop.w, pin.crop.h, 0, 0, w, h);
    renderDiag();
  };

  const renderDiag = () => {
    if (!pin) return;
    const dpr = window.devicePixelRatio;
    const cssPx = `${innerWidth}×${innerHeight} css → ${(innerWidth * dpr).toFixed(1)}×${(innerHeight * dpr).toFixed(1)} px`;
    const exact = Math.abs(innerWidth * dpr - canvas.width) < 0.5 && Math.abs(innerHeight * dpr - canvas.height) < 0.5;
    diag.textContent =
      `crop ${pin.crop.x},${pin.crop.y} ${pin.crop.w}×${pin.crop.h}\n` +
      `scale ${pin.scale.toFixed(3)}  dpr ${dpr}\n` +
      `canvas ${canvas.width}×${canvas.height}\n${cssPx}\n` +
      `像素对齐 ${exact ? "是" : "否（被浏览器重采样）"}\n` +
      (info ? `窗口 ${info.innerW}×${info.innerH} @ ${info.outerX},${info.outerY} sf ${info.scaleFactor}\n${info.monitor ?? ""}` : "");
  };

  const applyState = (snap) => {
    const next = snap.pins.find((p) => p.id === id);
    if (!next) return;
    const passthrough = snap.passthrough.includes(id);
    info = snap.windows.find((w) => w.id === id) ?? null;
    const needRedraw = !pin || pin.scale !== next.scale;
    pin = { ...next, passthrough };
    for (const b of app.querySelectorAll(".bar button[data-act]")) {
      const act = b.dataset.act;
      if (act in pin) b.classList.toggle("on", !!pin[act]);
    }
    if (pin.locked) drag.removeAttribute("data-tauri-drag-region");
    else drag.setAttribute("data-tauri-drag-region", "");
    document.body.classList.toggle("locked", pin.locked);
    document.body.classList.toggle("through", passthrough);
    badge.textContent = [passthrough ? "穿透" : "", pin.locked ? "锁定" : "", pin.onTop ? "" : "未置顶"]
      .filter(Boolean)
      .join(" · ");
    if (wasPassthrough && !passthrough) {
      // Visible confirmation that the exit key worked.
      document.body.classList.remove("flash");
      void document.body.offsetWidth;
      document.body.classList.add("flash");
    }
    wasPassthrough = passthrough;
    if (needRedraw) draw();
    else renderDiag();
  };

  const act = async (name) => {
    try {
      if (name === "close") return await invoke("close_pin", { id });
      if (name === "one") return await invoke("set_scale", { id, scale: 1 });
      await invoke("set_flag", { id, flag: name, value: !pin[name] });
    } catch (e) {
      badge.textContent = String(e);
    }
  };

  app.querySelector(".bar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) act(b.dataset.act);
  });
  window.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!pin || pin.locked) return;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      let next = pin.scale * factor;
      if (Math.abs(next - 1) < 0.04) next = 1; // snap to 1:1 when passing it
      invoke("set_scale", { id, scale: next });
    },
    { passive: false },
  );
  window.addEventListener("keydown", (e) => {
    // Ctrl+wheel / Ctrl+± browser zoom would silently break 1:1.
    if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "a") act("onTop");
    else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "l") act("locked");
    else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "t") act("passthrough");
    else if (!e.ctrlKey && e.key === "1") act("one");
    else if (!e.ctrlKey && e.key.toLowerCase() === "d") diag.hidden = !diag.hidden;
  });
  window.addEventListener("resize", draw);
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", draw);

  await listen("pins-changed", (e) => applyState(e.payload));
  const snap = await invoke("get_state");
  const first = snap.pins.find((p) => p.id === id);
  if (!first) return;
  try {
    img = await loadImage(first.src);
  } catch (e) {
    badge.textContent = `原图缺失：${first.src}`;
  }
  applyState(snap);
  draw();
}

// ---------------------------------------------------------------- control window

async function controlView() {
  document.body.classList.add("control");
  app.innerHTML = `
    <aside>
      <h1>钉图原型 <small>PROTOTYPE · #7</small></h1>
      <section>
        <h2>1 选图</h2>
        <div id="samples"></div>
        <button id="openFile">打开本地图片…</button>
      </section>
      <section>
        <h2>穿透退出</h2>
        <div id="shortcut"></div>
        <div class="row">
          <input id="accel" placeholder="例如 Ctrl+Alt+F10" />
          <button id="setAccel">更换</button>
        </div>
        <button id="toggleAll">切换全部穿透</button>
        <p class="hint">托盘图标菜单也能“恢复交互”。重开后穿透一律关闭。</p>
      </section>
      <section>
        <h2>使用日志</h2>
        <label><input type="checkbox" id="logging" /> 记录到本地文件（默认关）</label>
        <p class="hint" id="dataFile"></p>
      </section>
    </aside>
    <main>
      <div class="stage-head">
        <h2>2 预选局部 <small id="srcName">未选图</small></h2>
        <div class="row">
          <span id="cropText">拖动框选局部</span>
          <button id="pinWhole" disabled>钉住整图</button>
          <button id="pinCrop" class="primary" disabled>钉住选区</button>
        </div>
      </div>
      <div class="stage"><div class="frame"><img id="preview" alt="" /><div id="sel" hidden></div></div></div>
      <h2>3 钉图状态</h2>
      <table id="pins"><thead><tr>
        <th>id</th><th>裁切（原图像素）</th><th>缩放</th><th>窗口物理尺寸</th><th>位置</th><th>sf</th><th>状态</th><th></th>
      </tr></thead><tbody></tbody></table>
      <details><summary>事件</summary><pre id="events"></pre></details>
    </main>`;

  const $ = (s) => app.querySelector(s);
  const preview = $("#preview");
  const sel = $("#sel");
  let current = null; // { src, w, h }
  let crop = null;

  for (const s of SAMPLES) {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.onclick = () => choose(s.src, s.name);
    $("#samples").append(b);
  }
  $("#openFile").onclick = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (path) choose(path, path.split(/[\\/]/).pop());
  };

  async function choose(src, name) {
    try {
      const img = await loadImage(src);
      current = { src, w: img.naturalWidth, h: img.naturalHeight };
      preview.src = img.src;
      $("#srcName").textContent = `${name} · ${current.w}×${current.h}`;
      setCrop(null);
      $("#pinWhole").disabled = false;
    } catch (e) {
      $("#srcName").textContent = String(e);
    }
  }

  function setCrop(c) {
    crop = c;
    $("#pinCrop").disabled = !c;
    if (!c) {
      sel.hidden = true;
      $("#cropText").textContent = "拖动框选局部";
      return;
    }
    const k = preview.clientWidth / current.w;
    Object.assign(sel.style, {
      left: `${c.x * k}px`,
      top: `${c.y * k}px`,
      width: `${c.w * k}px`,
      height: `${c.h * k}px`,
    });
    sel.hidden = false;
    $("#cropText").textContent = `局部 ${c.x},${c.y} · ${c.w}×${c.h}`;
  }

  // Selection in oriented source pixels (naturalWidth already reflects EXIF orientation).
  let dragStart = null;
  const toSrc = (e) => {
    const r = preview.getBoundingClientRect();
    const k = current.w / r.width;
    return {
      x: Math.max(0, Math.min(current.w, Math.round((e.clientX - r.left) * k))),
      y: Math.max(0, Math.min(current.h, Math.round((e.clientY - r.top) * k))),
    };
  };
  preview.addEventListener("pointerdown", (e) => {
    if (!current) return;
    e.preventDefault();
    preview.setPointerCapture(e.pointerId);
    dragStart = toSrc(e);
  });
  preview.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const p = toSrc(e);
    const c = {
      x: Math.min(p.x, dragStart.x),
      y: Math.min(p.y, dragStart.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    };
    setCrop(c.w >= 8 && c.h >= 8 ? c : null);
  });
  preview.addEventListener("pointerup", () => (dragStart = null));
  window.addEventListener("resize", () => crop && setCrop(crop));

  const pin = (c) => invoke("create_pin", { src: current.src, crop: c }).catch((e) => alert(e));
  $("#pinWhole").onclick = () => pin({ x: 0, y: 0, w: current.w, h: current.h });
  $("#pinCrop").onclick = () => crop && pin(crop);

  $("#toggleAll").onclick = () => invoke("toggle_all");
  $("#setAccel").onclick = async () => {
    const v = $("#accel").value.trim();
    if (v) render(await invoke("change_exit_shortcut", { accelerator: v }));
  };
  $("#logging").onchange = (e) => invoke("set_logging", { on: e.target.checked });

  function render(snap) {
    $("#shortcut").innerHTML = snap.exitShortcut
      ? `<b class="key">${snap.exitShortcut}</b> 全局切换穿透${snap.shortcutError ? `<p class="warn">先前候选失败：${snap.shortcutError}</p>` : ""}`
      : `<p class="warn">未注册退出快捷键，穿透已禁用：${snap.shortcutError ?? ""}</p>`;
    $("#logging").checked = snap.logToFile;
    $("#dataFile").textContent = `数据：${snap.dataFile}`;
    const rows = snap.pins.map((p) => {
      const w = snap.windows.find((x) => x.id === p.id);
      const want = [Math.round(p.crop.w * p.scale), Math.round(p.crop.h * p.scale)];
      const ok = w && w.innerW === want[0] && w.innerH === want[1];
      const flags = [
        p.onTop ? "置顶" : "未置顶",
        p.locked ? "锁定" : "",
        snap.passthrough.includes(p.id) ? "穿透" : "",
      ].filter(Boolean).join(" · ");
      return `<tr>
        <td>${p.id}</td>
        <td>${p.crop.x},${p.crop.y} ${p.crop.w}×${p.crop.h}</td>
        <td>${p.scale === 1 ? "1:1" : p.scale.toFixed(3)}</td>
        <td class="${ok ? "" : "warn"}">${w ? `${w.innerW}×${w.innerH}` : "?"}${ok ? "" : ` ≠ ${want.join("×")}`}</td>
        <td>${p.x},${p.y}</td>
        <td>${w ? w.scaleFactor.toFixed(3) : "?"}</td>
        <td>${flags}</td>
        <td><button data-close="${p.id}">关闭</button></td>
      </tr>`;
    });
    $("#pins tbody").innerHTML = rows.join("") || `<tr><td colspan="8" class="hint">还没有钉图</td></tr>`;
    $("#events").textContent = snap.events.slice().reverse().join("\n");
  }
  $("#pins").addEventListener("click", (e) => {
    const id = e.target.dataset?.close;
    if (id) invoke("close_pin", { id });
  });

  await listen("pins-changed", (e) => render(e.payload));
  render(await invoke("get_state"));
  // Window facts (scale factor, real size) change without events, e.g. on restore or DPI change.
  setInterval(async () => render(await invoke("get_state")), 1000);
}
