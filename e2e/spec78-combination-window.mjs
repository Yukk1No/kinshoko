// Native window controls of the frameless main window (design/ui-system/README.md, 窗口框架), on the isolated
// build's one main HWND: WinCtrls minimize / maximize / restore, header double-click, header drag, and close to tray.
// Physical DPI, pen and real-hand mouse checks stay developer-only (unverified here).
import { until } from "./spec78-combination-driver.mjs";

const visibleControl = "const b=[...document.querySelectorAll('.k-win-ctrls button')].find(n=>n.getAttribute('aria-label')===arguments[0]&&n.getClientRects().length>0);";
// An empty point of a header drag region: the hit element is the header itself, not a control inside it.
const headerPoint = `const out=[];for(const h of document.querySelectorAll('header[data-tauri-drag-region]')){const r=h.getBoundingClientRect();if(!r.width||!r.height)continue;
for(let x=r.right-160;x>r.left+8;x-=12){const y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(hit===h)out.push({x,y,cls:h.className});}}
const p=out.find(p=>p.cls.includes('topbar'))??out[0];return p?{x:p.x,y:p.y,dpr:devicePixelRatio,header:p.cls}:null;`;

export async function nativeWindowControls(workflow) {
  workflow.phase("native-window-controls");
  const d = workflow.d, result = { steps: [] };
  const note = (step, value) => { result.steps.push({ step, ...value }); return value; };
  const state = () => d.nativeWindow("state").after;
  const same = (a, b, slack = 2) => Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack && Math.abs(a.width - b.width) <= slack && Math.abs(a.height - b.height) <= slack;
  const press = async label => {
    await until("visible window control " + label, () => d.exec(visibleControl + "return !!b;", [label]));
    await d.exec(visibleControl + "b.click();return true;", [label]);
  };
  const screenPoint = async () => {
    const p = await until("an empty header drag point", () => d.exec(headerPoint));
    const s = state();
    return { x: s.client.x + Math.round(p.x * p.dpr), y: s.client.y + Math.round(p.y * p.dpr), css: p };
  };
  await d.main();
  const start = note("start", state());
  d.assert(start.visible && !start.iconic && !start.zoomed && start.trayIcons === 1, "the frameless main window starts normal and visible, with one tray icon", start);

  await press("最小化");
  note("minimized", await until("WinCtrls 最小化 actually minimizes the HWND", () => { const s = state(); return s.iconic ? s : null; }));
  note("restored-from-minimize", d.nativeWindow("restore"));
  const restored = await until("restore returns to the same rect", () => { const s = state(); return !s.iconic && s.visible && same(s.rect, start.rect) ? s : null; });
  d.assert(true, "WinCtrls minimize, then restore, returns the window to its rect", restored);

  await press("最大化");
  note("maximized", await until("WinCtrls 最大化 actually maximizes the HWND", () => { const s = state(); return s.zoomed ? s : null; }));
  await until("the middle control now reads 还原", () => d.exec(visibleControl + "return !!b;", ["还原"]));
  await press("还原");
  note("restored-from-maximize", await until("WinCtrls 还原 restores the rect", () => { const s = state(); return !s.zoomed && same(s.rect, start.rect) ? s : null; }));
  d.assert(true, "WinCtrls maximize, then 还原, restores the window rect");

  d.nativeWindow("foreground");
  const first = await screenPoint();
  note("header-dblclick-maximize", { point: first, input: d.nativeWindow("dblclick", first.x, first.y) });
  note("dblclick-maximized", await until("double-clicking the header maximizes", () => { const s = state(); return s.zoomed ? s : null; }));
  const second = await screenPoint();
  note("header-dblclick-restore", { point: second, input: d.nativeWindow("dblclick", second.x, second.y) });
  note("dblclick-restored", await until("double-clicking the header again restores", () => { const s = state(); return !s.zoomed && same(s.rect, start.rect) ? s : null; }));
  d.assert(true, "double-clicking an empty header spot maximizes, and again restores");

  d.nativeWindow("foreground");
  const grip = await screenPoint(), dx = 60, dy = 40;
  note("drag", { point: grip, input: d.nativeWindow("drag", grip.x, grip.y, dx, dy) });
  const moved = note("dragged", await until("dragging the header moves the window", () => { const s = state(); return same(s.rect, { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy }, 3) ? s : null; }));
  d.assert(!moved.zoomed && moved.rect.width === start.rect.width && moved.rect.height === start.rect.height, "dragging the header moves the window by the drag distance without resizing it", moved);
  const back = await screenPoint();
  note("drag-back", { point: back, input: d.nativeWindow("drag", back.x, back.y, -dx, -dy) });
  note("dragged-back", await until("dragging back returns the window", () => { const s = state(); return same(s.rect, start.rect, 3) ? s : null; }));

  await d.screenshot("12-window-controls-before-close.png");
  await press("关闭");
  // Closing destroys the main window to free its WebView; the process keeps running in the tray (ADR 0004).
  const closed = note("closed", await until("关闭 removes the main window", () => { const s = state(); return !s.visible ? s : null; }));
  d.assert(closed.trayIcons === 1 && closed.pid === start.pid, "关闭 closes only the main window; the same process keeps running in the tray (ADR 0004)", closed);
  const reopenedInput = note("tray-open", d.nativeWindow("tray-open"));
  const reopened = note("reopened", await until("tray 打开 Kinshoko shows a main window again", () => { const s = state(); return s.visible && !s.iconic ? s : null; }));
  d.assert(reopened.pid === start.pid && reopened.trayIcons === 1 && reopenedInput.items[0].text === "打开 Kinshoko", "the tray's 打开 Kinshoko shows the main window again in the same process", reopened);
  workflow.state.windowControls = result; workflow.save();
  return result;
}
