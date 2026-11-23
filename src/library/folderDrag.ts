// 左栏文件夹拖动排顺序（#636，样子见 design/ui-system/main-window-material.md“拖动排顺序”，原型 design/prototype/main-window-material/Folders.ts）。
// 拖动用指针事件，直接改各行的 transform，不经过 React：拖着时每一帧都要动几十行，状态放进 React 会跟不上指针。
// 松手后交给 SidebarPane 调后端；目录重画之后，各行从它刚才在屏幕上的位置弹到新位置。
// 把图片从图片墙拖到文件夹上仍是浏览器的拖放，不经过这里。
import { reducedNow } from "../ui/reducedMotion";
import { gapAim, INTO_BAND, LAST, rowAt, sameAim, type DragRow, type DropAim, type FolderMove } from "./folderMove";

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
const SETTLE = spring(0.78);
const SETTLE_MS = 280; // 行让开、合上、弹回
const LAND = spring(0.7);
const LAND_MS = 360; // 松手后落到新位置
const FOLLOW_MS = 42; // 手里那一张跟手的迟滞（指数趋近的时间常数）
const LEAN = 6; // 线两边最近的一行让开 6 px，往外每行是前一行的 0.7 倍、晚 24 ms 出发
const FALLOFF = 0.7;
const STAGGER_MS = 24;
const INTO_MS = 320; // 在一行中段停这么久算“放进去”
const START_PX = 4; // 按下后移动这么远才算开始拖
const INDENT = 16; // 每深一层缩进
const EDGE = 32; // 指针离滚动区上下边这么近时自动滚动
const SCROLL_MAX = 14; // 自动滚动每帧最多滚这么多

export type FolderDragHost = {
  /** 把文件夹移过去；成功时 resolve。 */
  move: (folderId: string, to: FolderMove) => Promise<unknown>;
};

/** 拖着的时候 <html> 上有这个属性：悬停高亮隐去，指针是抓住的手。 */
const DRAGGING = "folderDragging";

const folderButtons = (nav: Element) =>
  [...nav.querySelectorAll<HTMLButtonElement>("button[data-folder-id]")].filter((button) => !button.closest("[inert]"));

type Row = DragRow & { el: HTMLElement; button: HTMLButtonElement; left: number; width: number };

function readRows(nav: Element): Row[] {
  return folderButtons(nav).map((button) => {
    const el = (button.closest(".k-fluid-row") as HTMLElement | null) ?? button;
    const rect = el.getBoundingClientRect();
    return {
      id: button.dataset.folderId as string,
      depth: Number(button.dataset.depth ?? 0),
      parent: button.dataset.parentFolder || null,
      el,
      button,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  });
}

type Place = { top: number; left: number; scale: number };

/**
 * 跑一次移动，再让每一行从移动前在屏幕上的位置（from，按文件夹 id）弹到新位置；移动后焦点落在挪过去的文件夹上。
 * cleanup 在目录重画之后、量新位置之前调用：拖动留下的 transform 在这时拿掉。
 */
export async function moveAndSettle(
  nav: Element,
  folderId: string,
  run: () => Promise<unknown>,
  from: Map<string, Place>,
  cleanup: () => void = () => {},
) {
  const changed = new Promise<void>((done) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      done();
    });
    observer.observe(nav, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      done();
    }, 800);
  });
  try {
    await run();
  } catch {
    cleanup();
    return;
  }
  await changed;
  // 放进刚展开的文件夹时，子文件夹那一块要再画一帧才出来。
  await new Promise((done) => requestAnimationFrame(done));
  cleanup();
  const rows = readRows(nav);
  const landed = rows.find((row) => row.id === folderId);
  landed?.button.focus({ preventScroll: true });
  landed?.button.scrollIntoView({ block: "nearest" });
  if (reducedNow() || !landed) return;
  const at = rows.indexOf(landed);
  for (const [index, row] of rows.entries()) {
    const was = from.get(row.id);
    if (!was) continue;
    const dx = was.left - row.left;
    const dy = was.top - row.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && was.scale === 1) continue;
    // 离落点越远的行越晚出发，像水波一样散出去。
    const mine = row.id === folderId;
    row.el.style.zIndex = mine ? "2" : "";
    row.el
      .animate([{ transform: `translate(${dx}px, ${dy}px) scale(${was.scale})` }, { transform: "none" }], {
        duration: LAND_MS,
        easing: LAND,
        delay: mine ? 0 : Math.min(Math.abs(index - at), 8) * 16,
        fill: "backwards",
      })
      .finished.then(
        () => {
          row.el.style.zIndex = "";
        },
        () => {},
      );
  }
}

/** 各行此刻在屏幕上的位置，给 {@link moveAndSettle} 用。 */
export function placesNow(nav: Element): Map<string, Place> {
  return new Map(readRows(nav).map((row) => [row.id, { top: row.top, left: row.left, scale: 1 }]));
}

/**
 * 在文件夹行上按下：移动超过几像素才开始拖，之前松开就是普通的点击。
 * 返回停止监听的函数（组件卸载时用）。
 */
export function armFolderDrag(button: HTMLButtonElement, down: PointerEvent, host: FolderDragHost): () => void {
  if (down.button !== 0 || DRAGGING in document.documentElement.dataset) return () => {};
  const move = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < START_PX) return;
    done();
    startDrag(button, down, event, host);
  };
  const done = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
  return done;
}

function startDrag(button: HTMLButtonElement, down: PointerEvent, first: PointerEvent, host: FolderDragHost) {
  const nav = button.closest("nav.sidebar") as HTMLElement | null;
  if (!nav) return;
  const section = nav.closest<HTMLElement>("[data-library-id]");
  const head = section?.querySelector<HTMLElement>(".lib-head-name") ?? null;
  const scroller = nav.closest<HTMLElement>(".side-scroll");
  const calm = reducedNow();
  const all = readRows(nav);
  const start = all.findIndex((row) => row.button === button);
  if (start < 0) return;
  const me = all[start];
  let end = start + 1;
  while (end < all.length && all[end].depth > me.depth) end++;
  const held = all.slice(start, end); // 拿起的文件夹与它里面展开着的
  const rest = [...all.slice(0, start), ...all.slice(end)];
  const closed = held.reduce((sum, row) => sum + row.height, 0);
  // 原位合上：后面的行上移这么多。减少动态效果时不合上。
  const shift = (row: Row) => (calm || all.indexOf(row) < start ? 0 : -closed);
  const aimRows: DragRow[] = rest.map((row) => ({ ...row, top: row.top + shift(row) }));
  const homeSiblings = all.filter((row) => row.parent === me.parent);
  const home = { parent: me.parent, position: homeSiblings.indexOf(me) };
  // “未归类”那一行不是落点，但线在最上面时它也跟着让一让。
  const lead = [...nav.querySelectorAll<HTMLElement>(":scope > .k-fluid > .k-fluid-row")].filter(
    (el) => !el.querySelector("button[data-folder-id]"),
  );
  const bounds = (nav.closest(".sidebar-slot") ?? scroller ?? nav).getBoundingClientRect();
  const view = scroller?.getBoundingClientRect() ?? bounds;
  const tree = (nav.querySelector(".sidebar-folders") ?? nav).getBoundingClientRect();
  const headRect = head?.getBoundingClientRect();
  const scroll0 = scroller?.scrollTop ?? 0;
  /** 拿起以后滚了多少：各行的位置都按拿起时量的，指针换算到那时的坐标里比。 */
  const scrolled = () => (scroller?.scrollTop ?? scroll0) - scroll0;

  // 手里的那一张：行的副本，固定定位，跟着指针走，缩到 90%、挂在指针右边，指针左边的落点线与行名都露着。
  const ghost = document.createElement("div");
  ghost.className = "folder-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const face = button.cloneNode(true) as HTMLElement;
  for (const name of ["id", "data-folder-id", "aria-current", "data-drop", "aria-label"]) face.removeAttribute(name);
  face.tabIndex = -1;
  face.style.width = `${me.width}px`;
  if (button.closest("li")?.hasAttribute("data-parent")) face.dataset.pile = "";
  ghost.append(face);
  document.body.append(ghost);
  const pointer = { x: first.clientX, y: first.clientY };
  const at = { x: me.left, y: me.top };
  const hang = () => ({ x: pointer.x + 14, y: pointer.y - me.height * 0.45 });
  let tilt = 0;
  let frame = 0;
  let last = performance.now();
  const place = () => {
    ghost.style.transform = `translate(${at.x}px, ${at.y}px) rotate(${tilt}deg)`;
  };
  place();

  const line = document.createElement("div");
  line.className = "folder-drag-line";
  line.setAttribute("aria-hidden", "true");
  line.append(document.createElement("i"));
  document.body.append(line);

  document.documentElement.dataset[DRAGGING] = "";
  for (const row of held) row.el.style.opacity = "0";
  const movers = [...lead, ...rest.map((row) => row.el)];
  if (!calm) for (const el of movers) el.style.transition = `transform ${SETTLE_MS}ms ${SETTLE}`;
  // 子文件夹那一块的折痕画在 <ul> 上，不跟着行走：拖着时它的上下沿跟着这一块里第一行与最后一行挪，
  // 整块都在手里时隐去。
  const creases = [...nav.querySelectorAll<HTMLElement>(".sidebar-tree .sidebar-tree")]
    .filter((ul) => !ul.closest("[inert]"))
    .map((ul) => ({ ul, rows: rest.filter((row) => ul.contains(row.el)) }));
  for (const { ul, rows } of creases) {
    ul.style.setProperty("--crease-ease", `${SETTLE_MS}ms ${SETTLE}`);
    if (rows.length === 0) ul.dataset.creaseHeld = "";
  }

  let target: DropAim | "top" | null = null;
  let dwell: { row: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let into: number | null = null;

  /** 落点线的位置（按拿起时的坐标），没有线时为 null。 */
  const lineY = () => {
    if (target === null || target === "top" || target.kind !== "gap") return null;
    const next = aimRows[target.gap];
    const before = aimRows[target.gap - 1];
    return next ? next.top : before ? before.top + before.height : tree.top;
  };
  const drawLine = () => {
    const y = lineY();
    const visible = y !== null && y - scrolled() >= view.top - 1 && y - scrolled() <= view.bottom + 1;
    if (y === null || !visible || target === null || target === "top" || target.kind !== "gap") {
      line.removeAttribute("data-on");
      return;
    }
    const x = tree.left + 8 + target.depth * INDENT;
    const fresh = !line.hasAttribute("data-on");
    if (fresh) line.style.transition = "none";
    line.style.width = `${tree.right - 8 - x}px`;
    line.style.transform = `translate(${x}px, ${y - scrolled() - 1}px)`;
    if (fresh) {
      void line.offsetWidth;
      line.style.transition = "";
    }
    line.toggleAttribute("data-on", true);
  };

  /** 各行摆到位：原位合上，线两边的让开。 */
  const arrange = () => {
    const gap = target !== null && target !== "top" && target.kind === "gap" ? target.gap : null;
    const offsets = new Map<Row, number>();
    rest.forEach((row, index) => {
      let lean = 0;
      let steps = 0;
      if (gap !== null && !calm) {
        steps = index < gap ? gap - 1 - index : index - gap;
        lean = (index < gap ? -1 : 1) * LEAN * FALLOFF ** steps;
      }
      row.el.style.transitionDelay = `${steps * STAGGER_MS}ms`;
      row.el.style.transform = calm ? "" : `translateY(${shift(row) + lean}px)`;
      offsets.set(row, calm ? 0 : shift(row) + lean);
      row.button.toggleAttribute(
        "data-folder-drop",
        target !== null && target !== "top" && target.kind === "into" && target.row === index,
      );
    });
    lead.forEach((el, index) => {
      const steps = (gap ?? 0) + lead.length - 1 - index;
      el.style.transitionDelay = `${steps * STAGGER_MS}ms`;
      el.style.transform = gap !== null && !calm ? `translateY(${-LEAN * FALLOFF ** steps}px)` : "";
    });
    head?.toggleAttribute("data-folder-drop", target === "top");
    for (const { ul, rows } of creases) {
      if (rows.length === 0) continue;
      ul.style.setProperty("--crease-top", `${offsets.get(rows[0]) ?? 0}px`);
      ul.style.setProperty("--crease-bottom", `${offsets.get(rows[rows.length - 1]) ?? 0}px`);
      ul.style.setProperty("--crease-delay", rows[0].el.style.transitionDelay);
    }
    drawLine();
  };

  /** 指针在哪里，落点就在哪里。坐标按“原位已经合上”的排列算，不受让开的那几像素影响。 */
  const aim = (x: number, viewY: number): DropAim | "top" | null => {
    if (x < bounds.left - 48 || x > bounds.right + 48) return null;
    const y = viewY + scrolled();
    // 拖到本库的标题上：移到最外面一层的最后。
    if (
      headRect &&
      me.depth > 0 &&
      y >= headRect.top &&
      y < headRect.bottom &&
      x >= headRect.left &&
      x <= headRect.right
    )
      return "top";
    if (aimRows.length === 0) return { kind: "gap", gap: 0, depth: 0, parent: null, position: 0 };
    const spot = rowAt(aimRows, y);
    if (!spot) return null;
    // 停在一行的中段：放进这个文件夹。
    if (spot.part > INTO_BAND[0] && spot.part < INTO_BAND[1]) {
      if (into === spot.row) return { kind: "into", row: spot.row };
      if (dwell?.row !== spot.row) {
        if (dwell) clearTimeout(dwell.timer);
        const row = spot.row;
        dwell = {
          row,
          timer: setTimeout(() => {
            into = row;
            retarget();
          }, INTO_MS),
        };
      }
    } else {
      if (dwell) clearTimeout(dwell.timer);
      dwell = null;
      into = null;
    }
    const gap = spot.part < 0.5 ? spot.row : spot.row + 1;
    return gapAim(aimRows, gap, me.depth, Math.round((x - down.clientX) / INDENT));
  };
  const retarget = () => {
    let next = aim(pointer.x, pointer.y);
    // 自己原来的位置上不画线。
    if (
      next !== null &&
      next !== "top" &&
      next.kind === "gap" &&
      next.parent === home.parent &&
      next.position === home.position
    )
      next = null;
    const same = next === "top" || target === "top" ? next === target : sameAim(next, target);
    if (same) return;
    target = next;
    arrange();
  };

  /** 拖到滚动区上下边缘时滚动。 */
  const autoScroll = () => {
    if (!scroller) return;
    const up = view.top + EDGE - pointer.y;
    const down = pointer.y - (view.bottom - EDGE);
    const speed = up > 0 ? -Math.min(1, up / EDGE) : down > 0 ? Math.min(1, down / EDGE) : 0;
    if (speed === 0 || pointer.x < bounds.left - 48 || pointer.x > bounds.right + 48) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.ceil(Math.abs(speed) * SCROLL_MAX) * Math.sign(speed);
    if (scroller.scrollTop !== before) {
      // 各行跟着滚走了，让开的位置与线都按新的滚动重新算。
      retarget();
      drawLine();
    }
  };
  const follow = (now: number) => {
    const k = calm ? 1 : 1 - Math.exp(-(now - last) / FOLLOW_MS);
    last = now;
    const to = hang();
    const vx = (to.x - at.x) * k;
    at.x += vx;
    at.y += (to.y - at.y) * k;
    tilt += ((calm ? 0 : Math.max(-2.5, Math.min(2.5, vx * 0.35))) - tilt) * 0.2;
    place();
    autoScroll();
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);
  // 拿起来的那一下：缩到 90%，带一个小的“啵”。
  face.style.setProperty("--held-pop", spring(0.6));
  requestAnimationFrame(() => {
    face.dataset.held = "";
  });
  retarget();
  arrange();

  const clear = () => {
    for (const { ul } of creases) {
      for (const name of ["--crease-top", "--crease-bottom", "--crease-delay", "--crease-ease"])
        ul.style.removeProperty(name);
      delete ul.dataset.creaseHeld;
    }
    for (const el of movers) {
      el.style.transition = "";
      el.style.transitionDelay = "";
      el.style.transform = "";
    }
    for (const row of all) {
      row.el.style.opacity = "";
      row.button.removeAttribute("data-folder-drop");
    }
    head?.removeAttribute("data-folder-drop");
    ghost.remove();
    line.remove();
    delete document.documentElement.dataset[DRAGGING];
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    if (dwell) clearTimeout(dwell.timer);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    // 松手后浏览器还会补一次点击：这一次不算选中。
    const swallow = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 60);
  };
  /** 取消：各行弹回，手里的那张飞回原位。 */
  const cancel = () => {
    stop();
    target = null;
    line.removeAttribute("data-on");
    for (const row of rest) {
      row.el.style.transitionDelay = "0ms";
      row.el.style.transform = "";
      row.button.removeAttribute("data-folder-drop");
    }
    for (const el of lead) {
      el.style.transitionDelay = "0ms";
      el.style.transform = "";
    }
    for (const { ul } of creases) {
      ul.style.setProperty("--crease-top", "0px");
      ul.style.setProperty("--crease-bottom", "0px");
      ul.style.setProperty("--crease-delay", "0ms");
      delete ul.dataset.creaseHeld;
    }
    head?.removeAttribute("data-folder-drop");
    delete face.dataset.held;
    if (calm) {
      clear();
      return;
    }
    ghost
      .animate(
        [{ transform: ghost.style.transform }, { transform: `translate(${me.left}px, ${me.top - scrolled()}px)` }],
        {
          duration: SETTLE_MS,
          easing: SETTLE,
          fill: "forwards",
        },
      )
      .finished.then(clear, clear);
  };
  const move = (event: PointerEvent) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    retarget();
  };
  const up = () => {
    const chosen = target;
    if (chosen === null) {
      cancel();
      return;
    }
    stop();
    const from = new Map<string, Place>();
    for (const row of rest) {
      const rect = row.el.getBoundingClientRect();
      from.set(row.id, { top: rect.top, left: rect.left, scale: 1 });
    }
    for (const row of held) from.set(row.id, { top: at.y + (row.top - me.top) * 0.9, left: at.x, scale: 0.9 });
    const to: FolderMove =
      chosen === "top"
        ? { parent: null, position: LAST }
        : chosen.kind === "into"
          ? { parent: rest[chosen.row].id, position: LAST }
          : { parent: chosen.parent, position: chosen.position };
    void moveAndSettle(nav, me.id, () => host.move(me.id, to), from, clear);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
