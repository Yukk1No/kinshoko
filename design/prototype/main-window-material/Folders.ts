// 第六轮（C4d）：文件夹视图的动作。叠在正式程序的左栏上，只读写 DOM，不改 src/。三件事：
//   1. 拖动文件夹：行跟着指针走（缩到 90%、挂在指针右边，不挡落点），原位合上；落点是一道细线，线两边的行像水波一样让开；
//      松手后各行弹到新位置。可以排到同级的任何位置，也可以放进另一个文件夹（在那一行上停一下）。Esc 或拖到左栏外面松手是取消。
//      键盘：Alt + ↑ ↓ 在同级里挪，Alt + → 放进上一个文件夹，Alt + ← 移到外面一层。
//   2. 选中的那张小纸片从旧的一行滑到新的一行。
//   3. 图库展开时各行依次落下，收起时合上。
// 系统设了“减少动态效果”时只留落点那道线：行不让开、不弹，纸片不滑。
import { moveFolder } from "../../../src/ipc";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 弹簧曲线，写成 CSS 的 linear()。damping 越小回弹越多：0.78 几乎不过冲，0.6 是一个小的“啵”。 */
function spring(damping: number) {
  const decay = 5.3; // 到终点时余量 0.5%
  const wd = (decay / damping) * Math.sqrt(1 - damping * damping);
  const points = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32;
    return (1 - Math.exp(-decay * t) * (Math.cos(wd * t) + (decay / wd) * Math.sin(wd * t))).toFixed(4);
  });
  points[32] = "1";
  return `linear(${points.join(", ")})`;
}
/** 每种动作各用一条曲线。 */
const SETTLE = spring(0.78), SETTLE_MS = 280; // 行让开、合上、弹回
const POP = spring(0.6), POP_MS = 240; // 拿起来的那一下
const LAND = spring(0.7), LAND_MS = 360; // 松手后落到新位置
const GLIDE = "cubic-bezier(0.3, 0.7, 0.2, 1)", GLIDE_MS = 150; // 落点线换位置
const FOLLOW_MS = 42; // 行跟手的迟滞（指数趋近的时间常数）

const LEAN = 6, FALLOFF = 0.7, STAGGER_MS = 24; // 线两边的行让开的距离：第 n 行是 LEAN × 0.7ⁿ，晚 24 ms × n 出发
const INTO_MS = 320; // 在一行上停这么久算“放进去”
const LAST = 2 ** 31;

type Row = { id: string; el: HTMLElement; button: HTMLButtonElement; depth: number; parent: string | null; top: number; left: number; width: number; height: number };
type Target = { kind: "gap"; gap: number; depth: number; parent: string | null; position: number } | { kind: "into"; row: number };

function readRows(nav: Element): Row[] {
  return [...nav.querySelectorAll<HTMLButtonElement>("button[data-folder-id]")].map((button) => {
    const el = button.parentElement as HTMLElement;
    const rect = el.getBoundingClientRect();
    const above = button.closest("li")?.parentElement?.closest("li")?.querySelector<HTMLElement>(":scope > .k-fluid-row > button[data-folder-id]");
    return { id: button.dataset.folderId as string, el, button, depth: Math.round((Number.parseFloat(button.style.paddingLeft) - 8) / 16),
      parent: above?.dataset.folderId ?? null, top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  });
}

let live: HTMLElement | null = null;
/** 读屏用户听到的结果。 */
function announce(text: string) {
  if (!live) { live = document.createElement("div"); live.className = "sr-only"; live.setAttribute("role", "status"); document.body.append(live); }
  live.textContent = text;
}
const name = (row: Row) => row.button.querySelector(".sidebar-label")?.textContent ?? "";

/**
 * 把文件夹移过去，再让每一行从它刚才在屏幕上的位置弹到新位置。
 * from 是移动前各行在屏幕上的位置（按文件夹 id），被拖的那一行用的是手里那张的位置与大小。
 */
async function commit(nav: Element, libraryId: string, id: string, parent: string | null, position: number, from: Map<string, { top: number; left: number; scale: number }>, cleanup: () => void) {
  const tree = nav.querySelector(".sidebar-folders") as HTMLElement;
  const changed = new Promise<void>((done) => {
    const observer = new MutationObserver(() => { observer.disconnect(); done(); });
    observer.observe(tree, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); done(); }, 600);
  });
  await moveFolder(libraryId, id, parent, position).catch((error) => console.warn("[prototype] move_folder", error));
  await changed;
  cleanup();
  const rows = readRows(nav);
  const landed = rows.find((row) => row.id === id);
  if (!reduced()) for (const row of rows) {
    const was = from.get(row.id);
    if (!was) continue;
    const dx = was.left - row.left, dy = was.top - row.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && was.scale === 1) continue;
    // 离落点越远的行越晚出发，让推开的动作像水波一样散出去。
    const steps = landed ? Math.abs(rows.indexOf(row) - rows.indexOf(landed)) : 0;
    row.el.style.zIndex = row.id === id ? "2" : "";
    row.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${was.scale})` }, { transform: "none" }],
      { duration: LAND_MS, easing: LAND, delay: row.id === id ? 0 : Math.min(steps, 8) * 16, fill: "backwards" })
      .finished.then(() => { row.el.style.zIndex = ""; }, () => {});
  }
  landed?.button.focus({ preventScroll: true });
  if (landed) {
    const inside = rows.find((row) => row.id === landed.parent);
    const place = rows.filter((row) => row.parent === landed.parent).indexOf(landed) + 1;
    announce(inside ? `“${name(landed)}”移到了“${name(inside)}”里的第 ${place} 个。` : `“${name(landed)}”移到了最外面一层的第 ${place} 个。`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. 拖动
// ---------------------------------------------------------------------------------------------------------------------
function startDrag(button: HTMLButtonElement, down: PointerEvent) {
  const nav = button.closest("nav.sidebar") as HTMLElement;
  const libraryId = button.closest<HTMLElement>("[data-library-id]")?.dataset.libraryId as string;
  const calm = reduced();
  const all = readRows(nav);
  const start = all.findIndex((row) => row.button === button);
  const me = all[start];
  let end = start + 1;
  while (end < all.length && all[end].depth > me.depth) end++;
  const held = all.slice(start, end); // 被拖的文件夹与它里面的
  const rest = [...all.slice(0, start), ...all.slice(end)];
  const closed = held.reduce((sum, row) => sum + row.height, 0);
  const shift = (index: number) => (index >= start ? -closed : 0); // 原位合上之后，后面的行上移这么多
  const home = { parent: me.parent, position: all.filter((row) => row.parent === me.parent).indexOf(me) };
  // “未归类”那一行不是落点，但线在最上面时它也跟着让一让。
  const lead = [...nav.querySelectorAll<HTMLElement>(":scope > .k-fluid > .k-fluid-row")];
  const bounds = nav.closest(".sidebar-slot")?.getBoundingClientRect() ?? nav.getBoundingClientRect();
  const treeRect = (nav.querySelector(".sidebar-folders") as HTMLElement).getBoundingClientRect();

  // 手里的那一张：行的副本，固定定位，跟着指针走。
  const ghost = document.createElement("div");
  ghost.className = "proto-drag-ghost";
  const face = button.cloneNode(true) as HTMLElement;
  face.removeAttribute("id");
  face.removeAttribute("data-folder-id");
  face.style.width = `${me.width}px`;
  if (held.length > 1) face.dataset.pile = "";
  ghost.append(face);
  document.body.append(ghost);
  // 拿起来以后挂在指针的右边、缩到 90%：指针左边的落点线与行名都露着。
  const hang = () => ({ x: pointer.x + 14, y: pointer.y - me.height * 0.45 });
  const pointer = { x: down.clientX, y: down.clientY };
  const at = { x: me.left, y: me.top };
  let tilt = 0, frame = 0, last = performance.now();
  const place = () => { ghost.style.transform = `translate(${at.x}px, ${at.y}px) rotate(${tilt}deg)`; };
  place();
  const follow = (now: number) => {
    const k = calm ? 1 : 1 - Math.exp(-(now - last) / FOLLOW_MS);
    last = now;
    const to = hang();
    const vx = (to.x - at.x) * k;
    at.x += vx; at.y += (to.y - at.y) * k;
    tilt += ((calm ? 0 : Math.max(-2.5, Math.min(2.5, vx * 0.35))) - tilt) * 0.2;
    place();
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);
  requestAnimationFrame(() => { face.dataset.held = ""; });

  const line = document.createElement("div");
  line.className = "proto-drag-line";
  line.append(document.createElement("i"));
  document.body.append(line);

  document.documentElement.dataset.dragging = "";
  for (const row of held) row.el.style.opacity = "0";
  const movers = [...lead, ...rest.map((row) => row.el)];
  if (!calm) for (const el of movers) el.style.transition = `transform ${SETTLE_MS}ms ${SETTLE}`;

  let target: Target | null = null;
  let dwell: { row: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let into: number | null = null;

  /** 各行摆到位：原位合上，线两边的让开。 */
  const arrange = () => {
    const gap = target?.kind === "gap" ? target.gap : null;
    rest.forEach((row, index) => {
      let lean = 0, steps = 0;
      if (gap !== null && !calm) { steps = index < gap ? gap - 1 - index : index - gap; lean = (index < gap ? -1 : 1) * LEAN * FALLOFF ** steps; }
      row.el.style.transitionDelay = `${steps * STAGGER_MS}ms`;
      row.el.style.transform = `translateY(${(calm ? 0 : shift(all.indexOf(row))) + lean}px)`;
      row.button.toggleAttribute("data-proto-drop", target?.kind === "into" && target.row === index);
    });
    lead.forEach((el, index) => {
      const steps = (gap ?? 0) + lead.length - 1 - index;
      el.style.transitionDelay = `${steps * STAGGER_MS}ms`;
      el.style.transform = gap !== null && !calm ? `translateY(${-LEAN * FALLOFF ** steps}px)` : "";
    });
    if (target?.kind === "gap") {
      const next = rest[target.gap], before = rest[target.gap - 1];
      const y = calm ? (next ? next.top : before.top + before.height) : next ? next.top + shift(all.indexOf(next)) : before ? before.top + before.height + shift(all.indexOf(before)) : treeRect.top;
      const x = treeRect.left + 8 + target.depth * 16;
      const fresh = !line.hasAttribute("data-on");
      if (fresh) line.style.transition = "none";
      line.style.width = `${treeRect.right - 8 - x}px`;
      line.style.transform = `translate(${x}px, ${y - 1}px)`;
      if (fresh) { void line.offsetWidth; line.style.transition = ""; }
      line.toggleAttribute("data-on", true);
    } else line.removeAttribute("data-on");
  };

  /** 指针在哪里，落点就在哪里。坐标按“原位已经合上”的排列算，不受让开的那几像素影响。 */
  const aim = (x: number, y: number): Target | null => {
    if (x < bounds.left - 48 || x > bounds.right + 48) return null;
    const tops = rest.map((row) => (calm ? row.top : row.top + shift(all.indexOf(row))));
    const count = rest.length;
    if (count === 0) return { kind: "gap", gap: 0, depth: 0, parent: null, position: 0 };
    if (y < tops[0] - 24 || y > tops[count - 1] + rest[count - 1].height + 36) return null;
    let over = tops.findIndex((top, index) => y < top + rest[index].height);
    if (over < 0) over = count - 1;
    const part = (y - tops[over]) / rest[over].height;
    // 停在一行的中段：放进这个文件夹。
    if (part > 0.25 && part < 0.75) {
      if (into === over) return { kind: "into", row: over };
      if (dwell?.row !== over) {
        if (dwell) clearTimeout(dwell.timer);
        dwell = { row: over, timer: setTimeout(() => { into = over; retarget(); }, INTO_MS) };
      }
    } else { if (dwell) clearTimeout(dwell.timer); dwell = null; into = null; }
    const gap = Math.max(0, Math.min(count, part < 0.5 ? over : over + 1));
    const next = gap < count ? rest[gap].depth : 0, before = gap > 0 ? rest[gap - 1].depth : 0;
    // 同一道缝可以属于不同的层（一组的末尾，或者外面一层）：默认留在原来那一层，往左右带一带就换层。
    const depth = Math.max(next, Math.min(Math.max(next, before), me.depth + Math.round((x - down.clientX) / 16)));
    let parent: string | null = null;
    for (let index = gap - 1; depth > 0 && index >= 0; index--) if (rest[index].depth === depth - 1) { parent = rest[index].id; break; }
    const position = rest.slice(0, gap).filter((row) => row.parent === parent).length;
    return { kind: "gap", gap, depth, parent, position };
  };
  const same = (a: Target | null, b: Target | null) => a?.kind === b?.kind && (a?.kind === "gap" && b?.kind === "gap" ? a.gap === b.gap && a.depth === b.depth : a?.kind === "into" && b?.kind === "into" ? a.row === b.row : true);
  const retarget = () => {
    let next = aim(pointer.x, pointer.y);
    // 自己原来的位置上不画线。
    if (next?.kind === "gap" && next.parent === home.parent && next.position === home.position) next = null;
    if (same(next, target)) return;
    target = next;
    arrange();
  };
  arrange();

  const clear = () => {
    for (const el of movers) { el.style.transition = ""; el.style.transitionDelay = ""; el.style.transform = ""; }
    for (const row of all) { row.el.style.opacity = ""; row.button.removeAttribute("data-proto-drop"); }
    ghost.remove();
    line.remove();
    delete document.documentElement.dataset.dragging;
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    if (dwell) clearTimeout(dwell.timer);
    button.removeEventListener("pointermove", move);
    button.removeEventListener("pointerup", up);
    button.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    // 松手后浏览器还会补一次点击：这一次不算选中。
    const swallow = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 60);
  };
  /** 取消：各行弹回，手里的那张飞回原位。 */
  const cancel = () => {
    stop();
    target = null;
    line.removeAttribute("data-on");
    for (const row of rest) { row.el.style.transitionDelay = "0ms"; row.el.style.transform = ""; row.button.removeAttribute("data-proto-drop"); }
    for (const el of lead) { el.style.transitionDelay = "0ms"; el.style.transform = ""; }
    delete face.dataset.held;
    if (calm) { clear(); return; }
    ghost.animate([{ transform: ghost.style.transform }, { transform: `translate(${me.left}px, ${me.top}px)` }], { duration: SETTLE_MS, easing: SETTLE, fill: "forwards" }).finished.then(clear, clear);
  };
  const move = (event: PointerEvent) => { pointer.x = event.clientX; pointer.y = event.clientY; retarget(); };
  const up = () => {
    const chosen = target;
    if (!chosen) { cancel(); return; }
    stop();
    const from = new Map<string, { top: number; left: number; scale: number }>();
    for (const row of rest) { const rect = row.el.getBoundingClientRect(); from.set(row.id, { top: rect.top, left: rect.left, scale: 1 }); }
    for (const row of held) from.set(row.id, { top: at.y + (row.top - me.top) * 0.9, left: at.x, scale: 0.9 });
    const [parent, position] = chosen.kind === "into" ? [rest[chosen.row].id, LAST] : [chosen.parent, chosen.position];
    void commit(nav, libraryId, me.id, parent, position, from, clear);
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } };
  try { button.setPointerCapture(down.pointerId); } catch { /* 指针已经松开 */ }
  button.addEventListener("pointermove", move);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}

function watchDrag() {
  // 正式程序的文件夹行用的是浏览器自带的拖放（放到另一个文件夹上 = 移进去）。原型里换成指针事件，才能自己画手里的那一张。
  window.addEventListener("dragstart", (event) => {
    if ((event.target as Element | null)?.closest?.("button[data-folder-id]")) event.preventDefault();
  }, true);
  window.addEventListener("pointerdown", (down) => {
    const button = (down.target as Element | null)?.closest?.<HTMLButtonElement>(".sidebar button[data-folder-id]");
    if (!button || down.button !== 0 || "dragging" in document.documentElement.dataset) return;
    const move = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < 4) return;
      done();
      startDrag(button, down);
    };
    const done = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", done); window.removeEventListener("pointercancel", done); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  });
  // 键盘：Alt + 方向键。
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.key.startsWith("Arrow")) return;
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(".sidebar button[data-folder-id]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const nav = button.closest("nav.sidebar") as HTMLElement;
    const rows = readRows(nav);
    const me = rows.find((row) => row.button === button) as Row;
    const siblings = rows.filter((row) => row.parent === me.parent);
    const index = siblings.indexOf(me);
    let to: [string | null, number] | null = null;
    if (event.key === "ArrowUp" && index > 0) to = [me.parent, index - 1];
    if (event.key === "ArrowDown" && index < siblings.length - 1) to = [me.parent, index + 1];
    if (event.key === "ArrowRight" && index > 0) to = [siblings[index - 1].id, LAST];
    if (event.key === "ArrowLeft" && me.parent !== null) {
      const outer = rows.find((row) => row.id === me.parent) as Row;
      to = [outer.parent, rows.filter((row) => row.parent === outer.parent).indexOf(outer) + 1];
    }
    if (!to) return;
    const from = new Map(rows.map((row) => [row.id, { top: row.top, left: row.left, scale: 1 }]));
    void commit(nav, button.closest<HTMLElement>("[data-library-id]")?.dataset.libraryId as string, me.id, to[0], to[1], from, () => {});
  }, true);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. 选中的小纸片滑过去。纸片画在行的 ::before 上（variants.css），这里只在选中换行时让它从旧位置出发。
// ---------------------------------------------------------------------------------------------------------------------
function watchSelection() {
  const pick = () => document.querySelector<HTMLElement>(".sidebar-slot :is(.k-row, .lib-head-name)[aria-current='page']");
  let chosen: HTMLElement | null = null;
  let was: DOMRect | null = null;
  const check = () => {
    const now = pick();
    if (now === chosen) { if (now) was = now.getBoundingClientRect(); return; }
    const from = chosen?.isConnected ? chosen.getBoundingClientRect() : was;
    const scroller = (el: Element | null) => el?.closest(".side-top, .side-scroll, .side-foot");
    const together = chosen?.isConnected && scroller(chosen) === scroller(now);
    chosen = now;
    if (!now) return;
    const to = now.getBoundingClientRect();
    was = to;
    if (reduced() || "dragging" in document.documentElement.dataset) return;
    if (from && together && from.height > 0) {
      now.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` }, { transform: "none" }],
        { duration: LAND_MS, easing: LAND, pseudoElement: "::before" });
    } else {
      // 隔着一道分界（“全部图片”、回收站）：不穿过去，原地浮起来。
      now.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: POP_MS, easing: POP, pseudoElement: "::before" });
    }
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. 图库展开与收起。正式程序展开时才画目录、收起时直接拿掉；原型在画出来的那一刻补上展开，在收起的点击之前先合上。
// ---------------------------------------------------------------------------------------------------------------------
function watchExpand() {
  const open = (nav: HTMLElement) => {
    if (reduced()) return;
    const height = nav.offsetHeight;
    nav.style.overflow = "clip";
    nav.animate([{ height: "0px" }, { height: `${height}px` }], { duration: 300, easing: SETTLE }).finished.then(() => { nav.style.overflow = ""; }, () => {});
    [...nav.querySelectorAll<HTMLElement>(".k-fluid-row")].forEach((row, index) => {
      row.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: SETTLE, delay: Math.min(index, 14) * 18, fill: "backwards" });
    });
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches("nav.sidebar")) open(node);
  }).observe(document.body, { subtree: true, childList: true });

  let through = false;
  window.addEventListener("click", (event) => {
    const toggle = (event.target as Element | null)?.closest?.<HTMLButtonElement>(".workspace-expand[aria-expanded='true']");
    const nav = toggle?.closest(".lib-group")?.querySelector<HTMLElement>("nav.sidebar");
    if (!toggle || !nav || through || reduced()) return;
    event.stopPropagation();
    event.preventDefault();
    nav.style.overflow = "clip";
    const finish = () => { through = true; toggle.click(); through = false; };
    nav.animate([{ height: `${nav.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 200, easing: "cubic-bezier(0.4, 0, 0.6, 1)", fill: "forwards" }).finished.then(finish, finish);
  }, true);
}

export function mountFolders() {
  const root = document.documentElement.style;
  root.setProperty("--proto-pop", POP);
  root.setProperty("--proto-pop-ms", `${POP_MS}ms`);
  root.setProperty("--proto-settle", SETTLE);
  root.setProperty("--proto-glide", GLIDE);
  root.setProperty("--proto-glide-ms", `${GLIDE_MS}ms`);
  watchDrag();
  watchSelection();
  watchExpand();
}
