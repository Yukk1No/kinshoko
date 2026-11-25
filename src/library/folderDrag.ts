// 左栏文件夹拖动排顺序（#636，样子见 design/ui-system/main-window-material.md“拖动排顺序”，原型 design/prototype/main-window-material/Folders.ts）。
// 拖动用指针事件，直接改各行的 transform，不经过 React：拖着时每一帧都要动几十行，状态放进 React 会跟不上指针。
// 松手后交给 SidebarPane 调后端；目录重画之后，各行从它刚才在屏幕上的位置弹到新位置。
// 把图片从图片墙拖到文件夹上仍是浏览器的拖放，不经过这里。
import { reducedNow } from "../ui/reducedMotion";
import { gapAim, INTO_BAND, LAST, rowAt, sameAim, type DragRow, type DropAim, type FolderMove } from "./folderMove";
import {
  EDGE,
  FALLOFF,
  FOLLOW_MS,
  INDENT,
  INTO_MS,
  LEAN,
  SCROLL_MAX,
  SETTLE,
  SETTLE_MS,
  STAGGER_MS,
  START_PX,
  spring,
} from "./folderDragMotion";
import { readRows, type Place, type Row } from "./folderDragRows";
import { moveAndSettle } from "./folderDragSettle";

export { moveAndSettle } from "./folderDragSettle";
export { placesNow } from "./folderDragRows";

export type FolderDragHost = {
  /** 把文件夹移过去；成功时 resolve。 */
  move: (folderId: string, to: FolderMove) => Promise<unknown>;
};

/** 拖着的时候 <html> 上有这个属性：悬停高亮隐去，指针是抓住的手。 */
const DRAGGING = "folderDragging";

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
