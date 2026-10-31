import { MENU_TIMING } from "./timing";
import { approachStrip, headingToSubmenu, safeTriangle, submenuSide, type Box, type Point } from "./safeZone";

/**
 * 一棵菜单树（主菜单与它的各层子菜单）的指针状态：哪一行悬停、哪些文件夹行展开，以及三段延时与安全区。
 * 行的高亮由这里的状态驱动（data-k-hover / data-k-active），不用 CSS :hover，也不用 Base UI 跟着指针走的
 * data-highlighted，安全区里途经的行才不会亮。键盘仍由 Base UI 负责：键盘打开或收起子菜单经
 * `requestOpen` 进来，键盘操作时高亮改看 data-highlighted（`input` 为 keyboard）。
 *
 * 行与层只在 DOM 上标记：行带 data-k-row（id）、data-k-depth、data-k-kind（folder | plain），
 * 层（浮层）带 data-k-level 并经 `registerLevel` 登记元素。
 */
export type MenuInput = "pointer" | "keyboard";
export type CascadeState = {
  /** open[d]：从第 d 层展开的文件夹行 id。 */
  open: readonly (string | null)[];
  /** hover[d]：第 d 层高亮的行 id。 */
  hover: readonly (string | null)[];
  input: MenuInput;
  /** 正在安全区里等待的行（调试层与测试用）。 */
  skipped: string | null;
};
export type CascadeDebug = {
  triangle: [Point, Point, Point] | null;
  strip: Box | null;
  timer: { label: string; startedAt: number; duration: number } | null;
};

type Row = { id: string; depth: number; folder: boolean; disabled: boolean };
type Pending = {
  row: string; depth: number; kind: "open" | "safe"; startedAt: number; duration: number;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
};

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
const inside = (p: Point, b: Box) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
/** 键盘与 Base UI 自己的开合原因里，这些不该由 Base UI 决定：指针相关的开合归这里管。 */
const IGNORED_REASONS = new Set(["trigger-hover", "sibling-open", "focus-out", "none"]);

export class CascadeController {
  private state: CascadeState = { open: [], hover: [], input: "pointer", skipped: null };
  private debugState: CascadeDebug = { triangle: null, strip: null, timer: null };
  private listeners = new Set<() => void>();
  private levels = new Map<number, HTMLElement>();
  /** 最近两次 pointermove 的位置；较早的一次是安全三角形的顶点。 */
  private history: Point[] = [];
  private pending: Pending | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStartedAt = 0;
  /** 指针进过菜单（触发按钮或某一层）之后，离开才会关闭整个菜单。 */
  private armed = false;
  private detach: (() => void) | null = null;

  /** 按钮打开的菜单才有：触发按钮与关闭整个菜单的办法。右键菜单没有，指针滑出不关。 */
  anchor: HTMLElement | null = null;
  closeAll: (() => void) | null = null;
  debug = false;

  constructor(private now: () => number = () => performance.now()) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getState = () => this.state;
  getDebug = () => this.debugState;

  private set(patch: Partial<CascadeState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
  private emit() { for (const listener of this.listeners) listener(); }

  /** 第 d 层的浮层挂上或卸下。第 0 层挂上时开始听文档上的指针与键盘。 */
  registerLevel(depth: number, el: HTMLElement | null, prev?: HTMLElement | null) {
    if (el) this.levels.set(depth, el);
    else if (prev && this.levels.get(depth) === prev) this.levels.delete(depth);
    if (depth === 0) {
      if (el && !this.detach) this.attach(el.ownerDocument);
      if (!el) this.reset();
    } else this.debugTick();
  }

  private attach(doc: Document) {
    const move = (e: PointerEvent | DragEvent) =>
      this.pointerMove({ x: e.clientX, y: e.clientY }, e.target as Element | null, {
        touch: "pointerType" in e && e.pointerType === "touch", dragging: e.type === "dragover",
      });
    // 键盘接手：还在等的悬停与离开即关都不再生效，免得它们晚到一步盖掉键盘的操作。
    const key = () => {
      this.cancelPending();
      this.cancelClose();
      if (this.state.input !== "keyboard") this.set({ input: "keyboard" });
    };
    const leave = (e: MouseEvent) => { if (!e.relatedTarget) this.pointerLeftWindow(); };
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("dragover", move, true);
    doc.addEventListener("keydown", key, true);
    doc.documentElement.addEventListener("mouseleave", leave);
    this.detach = () => {
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("dragover", move, true);
      doc.removeEventListener("keydown", key, true);
      doc.documentElement.removeEventListener("mouseleave", leave);
    };
  }

  /**
   * 按钮打开了菜单。用指针点开的，开的那一下就算进过触发按钮，之后第一次移到外面就开始计时关闭；
   * 用键盘打开的，一开始就按键盘高亮（打开的那次按键早于文档上的监听）。
   */
  openedFrom(anchor: HTMLElement | null, byPointer: boolean) {
    this.anchor = anchor;
    this.armed = byPointer;
    this.set({ input: byPointer ? "pointer" : "keyboard" });
  }

  /** 整个菜单关闭：清掉状态、计时与监听。 */
  reset() {
    this.cancelPending();
    this.cancelClose();
    this.detach?.();
    this.detach = null;
    this.history = [];
    this.armed = false;
    this.anchor = null;
    this.state = { open: [], hover: [], input: "pointer", skipped: null };
    this.debugState = { triangle: null, strip: null, timer: null };
    this.emit();
  }

  /** Base UI 要开合第 d 层的子菜单 id（键盘、点击、Esc、点在外面）。指针相关的原因不听。 */
  requestOpen(depth: number, id: string, next: boolean, reason: string) {
    if (IGNORED_REASONS.has(reason)) return;
    this.cancelPending();
    if (reason === "list-navigation" || reason === "escape-key") this.set({ input: "keyboard" });
    if (next) this.openAt(depth, id);
    else if (this.state.open[depth] === id) this.openAt(depth, null);
  }

  private openAt(depth: number, id: string | null) {
    const open = this.state.open.slice(0, depth);
    if (id) open[depth] = id;
    const hover = this.state.hover.slice(0, depth + 1);
    this.set({ open, hover });
  }

  private hoverAt(depth: number, id: string | null) {
    if (this.state.hover[depth] === id) return;
    const hover = this.state.hover.slice();
    hover[depth] = id;
    this.set({ hover });
  }

  /** 指针在文档上移动（含拖放时的 dragover）。target 是指针下的元素。 */
  pointerMove(point: Point, target: Element | null, { touch = false, dragging = false } = {}) {
    this.history = [this.history[this.history.length - 1] ?? point, point];
    if (this.state.input !== "pointer") this.set({ input: "pointer" });
    const levelEl = target?.closest<HTMLElement>("[data-k-level]") ?? null;
    const level = levelEl ? Number(levelEl.dataset.kLevel) : null;
    const rowEl = target?.closest<HTMLElement>("[data-k-row]") ?? null;

    // 指针进了已打开的子菜单：保护到此为止，父层回到展开的那一行。
    if (level !== null && level >= 1 && this.state.open[level - 1]) {
      if (this.pending && this.pending.depth < level) this.cancelPending();
      this.hoverAt(level - 1, this.state.open[level - 1]);
    }

    if (rowEl && level !== null) this.overRow(rowEl, { touch, dragging });
    else if (this.pending) this.cancelPending();
    if (level === null) this.clearHoverOutside();

    this.checkLeave(point, level !== null);
    if (this.debug) this.updateDebug();
  }

  private overRow(rowEl: HTMLElement, { touch, dragging }: { touch: boolean; dragging: boolean }) {
    const disabled = rowEl.hasAttribute("data-disabled");
    const row: Row = { id: rowEl.dataset.kRow!, depth: Number(rowEl.dataset.kDepth), folder: !disabled && rowEl.dataset.kKind === "folder", disabled };
    const child = this.state.open[row.depth] ?? null;

    if (child === row.id) {
      if (this.pending) this.cancelPending();
      this.hoverAt(row.depth, row.id);
      return;
    }
    if (this.pending?.row === row.id) {
      // 同一行上继续移动：安全区等待中且指针已离开安全区，就立刻换过去。
      if (this.pending.kind === "safe" && !this.inSafeZone(row.depth)) this.commit(row);
      return;
    }
    this.cancelPending();
    if (child && !touch && this.inSafeZone(row.depth)) {
      const startedAt = this.now();
      const timer = setInterval(() => {
        if (!this.inSafeZone(row.depth) || this.now() - startedAt >= MENU_TIMING.safeWindowMax) this.commit(row);
      }, MENU_TIMING.safeRecheck);
      this.pending = { row: row.id, depth: row.depth, kind: "safe", startedAt, duration: MENU_TIMING.safeWindowMax, timer };
      this.set({ skipped: row.id });
      return;
    }
    this.hoverAt(row.depth, row.disabled ? null : row.id);
    // 普通行只在有更深的子菜单时才需要等；没有就什么也不做。
    if (!row.folder && !child) return;
    if (touch) { this.apply(row); return; }
    const duration = dragging && row.folder ? MENU_TIMING.dragOpenDelay : MENU_TIMING.openDelay;
    const timer = setTimeout(() => { this.pending = null; this.apply(row); }, duration);
    this.pending = { row: row.id, depth: row.depth, kind: "open", startedAt: this.now(), duration, timer };
  }

  /** 安全区等待结束：这一行高亮，并换上它的子菜单（或收起更深的子菜单）。 */
  private commit(row: Row) {
    this.cancelPending();
    this.hoverAt(row.depth, row.disabled ? null : row.id);
    this.apply(row);
  }

  private apply(row: Row) {
    if (row.folder) this.openAt(row.depth, row.id);
    else if (this.state.open[row.depth]) this.openAt(row.depth, null);
    this.debugTick();
  }

  private cancelPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer as ReturnType<typeof setTimeout>);
    clearInterval(this.pending.timer as ReturnType<typeof setInterval>);
    this.pending = null;
    if (this.state.skipped) this.set({ skipped: null });
  }

  /** 指针不在任何一层上：没展开的行不再高亮。 */
  private clearHoverOutside() {
    const hover = this.state.hover.map((id, d) => (id && this.state.open[d] === id ? id : null));
    if (hover.some((id, d) => id !== this.state.hover[d])) this.set({ hover });
  }

  /** 第 d 层展开着子菜单时，指针是否正在去那个子菜单的路上。 */
  private inSafeZone(depth: number) {
    const zone = this.zone(depth);
    if (!zone || this.history.length < 2) return false;
    return headingToSubmenu({ apex: this.history[0], point: this.history[1], parent: zone.parent, submenu: zone.submenu });
  }

  private zone(depth: number) {
    if (!this.state.open[depth]) return null;
    const parentEl = this.levels.get(depth), submenuEl = this.levels.get(depth + 1);
    if (!parentEl || !submenuEl) return null;
    return { parent: boxOf(parentEl), submenu: boxOf(submenuEl) };
  }

  // ---- 离开即关（只对按钮打开的菜单） ----

  private checkLeave(point: Point, inLevel: boolean) {
    if (!this.closeAll) return;
    const inAnchor = !!this.anchor && inside(point, boxOf(this.anchor));
    const inZone = this.state.open.some((id, d) => id && this.inSafeZone(d));
    const within = inLevel || inAnchor || inZone || [...this.levels.values()].some((el) => inside(point, boxOf(el)));
    if (within) { this.armed = true; this.cancelClose(); return; }
    if (this.armed) this.scheduleClose();
  }

  private pointerLeftWindow() {
    if (this.closeAll && this.armed) this.scheduleClose();
  }

  private scheduleClose() {
    if (this.closeTimer) return;
    this.closeStartedAt = this.now();
    this.closeTimer = setTimeout(() => { this.closeTimer = null; this.closeAll?.(); }, MENU_TIMING.closeDelay);
    this.debugTick();
  }

  private cancelClose() {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.debugTick();
  }

  // ---- 调试层 ----

  private debugTick() { if (this.debug) this.updateDebug(); }

  private updateDebug() {
    const depth = this.state.open.reduce((deepest, id, d) => (id ? d : deepest), -1);
    const zone = depth >= 0 ? this.zone(depth) : null;
    const side = zone ? submenuSide(zone.parent, zone.submenu) : null;
    const apex = this.history[0];
    const p = this.pending;
    this.debugState = {
      triangle: zone && side && apex ? safeTriangle(apex, zone.submenu, side) : null,
      strip: zone && side ? approachStrip(zone.parent, side) : null,
      timer: this.closeTimer ? { label: "关闭", startedAt: this.closeStartedAt, duration: MENU_TIMING.closeDelay }
        : p ? { label: p.kind === "safe" ? "安全区" : "悬停", startedAt: p.startedAt, duration: p.duration }
        : null,
    };
    this.emit();
  }
}

/** 调试层开关：在开发者工具里执行 localStorage.setItem("kinshoko.menuDebug", "1") 后重新打开菜单。默认关。 */
export function menuDebugEnabled() {
  try { return window.localStorage.getItem("kinshoko.menuDebug") === "1"; } catch { return false; }
}
