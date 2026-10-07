import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { PinFrame } from "../bindings/PinFrame";
import type { SavedPin } from "../bindings/SavedPin";
import {
  captureUrl,
  movePin,
  pinImageUrl,
  onPinFrame,
  onPinNotice,
  pinFrame,
  pinMenu,
  pinReady,
  revealPin,
  setPinOpacity,
  settlePin,
  turnPin,
  zoomPin,
  type PinTurn,
} from "../ipc";
import {
  ContentMotion,
  HOLD_MS,
  HOLD_SLOP,
  SLIDE_MS,
  ZOOM_MS,
  contentTransform,
  heldForMenu,
  pressOpensMenu,
  wheelOpacity,
} from "./motion";
import { createCanvas2dRenderer, pinSourceSize, type PinRenderer, type PinSource } from "./renderer";
import {
  cornerZoomScale,
  inZoomCorner,
  pinCanvasSize,
  wheelZoomScale,
  type Point,
  type ZoomStart,
} from "./pixels";

/** 画面内容变了才重画 canvas（位置变化只改 CSS 变换）。 */
function drawKey(pin: SavedPin, source: string): string {
  const p = pin.placement;
  return JSON.stringify([source, pin.width, pin.height, pin.crop, p.scale, p.flipH, p.flipV, p.rotation]);
}

/** 钉图此刻应该画的源图地址：截图本身，或资料库钉图经参考视角的显示文件（#65）。 */
function sourceUrl(f: PinFrame): string {
  const content = f.pin.content;
  if (content.kind === "capture") return captureUrl(content.captureId);
  return pinImageUrl(f.pin.id, pinSourceSize(f.pin, f.veiled));
}

/** 缩放停下这么久后才换源图（派生图按尺寸生成，滚轮连续几格时不每格都生成）。 */
const SOURCE_IDLE_MS = 150;

/** 只发最新的一次：上一次还没返回时，新的请求替换排队中的那个。拖动时不会积压 IPC。 */
function latestOnly<A extends unknown[]>(send: (...args: A) => Promise<unknown>) {
  let busy = false;
  let queued: A | null = null;
  const run = (...args: A) => {
    if (busy) {
      queued = args;
      return;
    }
    busy = true;
    void send(...args)
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (queued) {
          const next = queued;
          queued = null;
          run(...next);
        }
      });
  };
  return run;
}

type Gesture = {
  pointerId: number;
  pointerType: string;
  /**
   * 按下处与最近一次的位置（屏幕上的 CSS 像素）和按下时间，用来判断按住不动打开菜单。
   * 用屏幕坐标：拖动时原生窗口跟着走，窗口内坐标几乎不变（#76 UI2）。
   */
  down: Point;
  last: Point;
  at: number;
  /** 屏幕位移曾经超过 [`HOLD_SLOP`]：这一笔是拖动，回到起点也不再算按住。 */
  dragged: boolean;
} & (
  | { kind: "move"; origin: Point }
  | { kind: "zoom"; origin: Point; start: ZoomStart }
  /** 锁定的钉图：只等按住打开菜单。 */
  | { kind: "hold" }
);

const TURN_KEYS: Record<string, PinTurn> = {
  h: "flipHorizontal",
  v: "flipVertical",
  r: "rotateClockwise",
  R: "rotateCounterClockwise",
};

/** 动画结束后等这么久没有新的缩放再改原生窗口：滚轮连续几格时窗口不来回变。 */
const SETTLE_IDLE_MS = 120;
/** 同一次按下引出的 pointerdown 与 contextmenu 只开一次菜单。 */
const MENU_DEDUPE_MS = 800;

/**
 * 钉图窗口：按 DPI 像素规则把截图画在物理像素尺寸的 canvas 上（未缩放时与截图逐像素一致）。
 *
 * 几何由应用壳以帧（`pin-frame`）推来：原生窗口在哪、内容要到哪。缩放与贴边滑动只在窗口里变换
 * 内容，不逐帧改原生窗口（#7、#64）；动画结束后请应用壳把窗口改成静止时的矩形。
 *
 * 笔、鼠标与触摸走同一套 pointer 处理（#7：Windows Ink 下笔拖动没有系统拖动需要的鼠标事件）：
 * 按住拖动移动，按住右下角拖动缩放，锁定时都不响应。滚轮以光标为中心缩放，Ctrl+滚轮调透明度；
 * H/V 翻转，R/Shift+R 旋转。右键菜单：鼠标右键、笔的侧键，或笔与触摸按住不动。
 *
 * 画面由可替换的钉图渲染器（[`PinRenderer`]，目前只有 canvas 2D）画。资料库钉图（#65）缩小时以
 * Rust 派生图为源；安全模式下被封印的图原位模糊并显示小圆锁，确认后只显示这一张。
 */
export function PinView({ pin }: { pin: string }) {
  const host = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<PinFrame | null>(null);
  const apply = useRef<(f: PinFrame) => void>(() => {});
  const settleSoon = useRef<() => void>(() => {});
  const menuAt = useRef(0);
  const [corner, setCorner] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [veiled, setVeiled] = useState(false);
  const [missing, setMissing] = useState(false);
  /** 应用壳核对出的不能显示的原因（资料库不可用、图已删除，#66）。 */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const openMenu = () => {
    const now = performance.now();
    if (now - menuAt.current < MENU_DEDUPE_MS) return;
    menuAt.current = now;
    gesture.current = null;
    void pinMenu(pin);
  };

  useEffect(() => {
    let alive = true;
    let motion: ContentMotion | null = null;
    let raf = 0;
    let settle = 0;
    let drawn = "";
    let renderer: PinRenderer | null = null;
    /** 画着的源图、它的地址，以及它是不是遮蔽时取的小图。 */
    let source: PinSource | null = null;
    let sourceAddress = "";
    let sourceVeiled = false;
    /** 正在读取或等着读取的地址。 */
    let wanted = "";
    let sourceTimer = 0;

    /** 遮蔽要立刻生效，不等 React 渲染：在宿主元素上直接切换。换成清晰的源图之前也保持遮蔽。 */
    const applyVeil = () => {
      const f = frame.current;
      const on = !!f && (f.veiled || sourceVeiled);
      host.current?.classList.toggle("pin-veiled", on);
      setVeiled(on);
      if (!on) setConfirming(false);
    };
    const load = async (address: string, veil: boolean): Promise<void> => {
      wanted = address;
      const img = new Image();
      img.src = address;
      try {
        await img.decode();
      } catch {
        if (!alive || wanted !== address) return;
        // 资料库没打开、原图缺失：保留已画的；什么都没有时画占位。
        if (!source) setMissing(true);
        redraw(true);
        return;
      }
      if (!alive || wanted !== address) return;
      source = { image: img, width: img.naturalWidth, height: img.naturalHeight };
      sourceAddress = address;
      sourceVeiled = veil;
      setMissing(false);
      redraw(false);
      applyVeil();
    };
    const pickSource = (immediate: boolean) => {
      const f = frame.current;
      if (!f) return;
      const address = sourceUrl(f);
      if (address === wanted) return;
      clearTimeout(sourceTimer);
      // 变成遮蔽时马上换小图；其余（缩放）等停下来再换。
      if (immediate || f.veiled) void load(address, f.veiled);
      else sourceTimer = window.setTimeout(() => void load(address, f.veiled), SOURCE_IDLE_MS);
    };

    const scheduleSettle = () => {
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        const f = frame.current;
        if (!f || gesture.current) return;
        void settlePin(pin, f.generation);
      }, SETTLE_IDLE_MS);
    };
    settleSoon.current = () => {
      if (motion?.done(performance.now())) scheduleSettle();
    };
    const tick = () => {
      raf = 0;
      const f = frame.current;
      const el = body.current;
      if (!f || !motion || !el) return;
      const now = performance.now();
      el.style.transform = contentTransform(motion.at(now), f.content, f.window, window.devicePixelRatio);
      if (!motion.done(now)) raf = requestAnimationFrame(tick);
      else if (f.motion !== "jump") scheduleSettle();
    };
    const redraw = (force: boolean) => {
      const f = frame.current;
      if (!f || !renderer) return;
      const key = drawKey(f.pin, sourceAddress);
      if (force || key !== drawn) {
        drawn = key;
        renderer.draw(source, f.pin);
      }
    };
    apply.current = (f) => {
      const now = performance.now();
      const first = frame.current === null;
      frame.current = f;
      motion ??= new ContentMotion(f.content, now);
      const duration = first ? 0 : f.motion === "zoom" ? ZOOM_MS : f.motion === "slide" ? SLIDE_MS : 0;
      motion.retarget(f.content, now, duration);
      applyVeil();
      redraw(false);
      if (renderer) pickSource(false);
      if (body.current) body.current.style.opacity = String(f.pin.opacity);
      setLocked(f.pin.locked);
      setUnavailable(f.unavailable ?? null);
      clearTimeout(settle);
      if (!raf) tick();
    };
    const onResize = () => {
      // 拖到缩放比例不同的显示器上时，按新的 dpr 重定 CSS 尺寸与偏移。
      redraw(true);
      tick();
    };

    const frames = onPinFrame((f) => {
      if (alive) apply.current(f);
    });
    (async () => {
      const first = await pinFrame(pin);
      if (!first || !alive || !body.current) return;
      renderer = createCanvas2dRenderer();
      if (!renderer) return;
      body.current.prepend(renderer.element);
      // 等第一帧期间可能已经到了更新的帧。
      if (!frame.current) apply.current(first);
      // 先画好（遮蔽的先取小图）再显示窗口。
      await load(sourceUrl(frame.current ?? first), (frame.current ?? first).veiled);
      if (!alive) return;
      redraw(true);
      pickSource(true);
      window.addEventListener("resize", onResize);
      await pinReady(pin);
    })();
    const unlisten = onPinNotice((text) => setNotice(text));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      clearTimeout(sourceTimer);
      window.removeEventListener("resize", onResize);
      void frames.then((stop) => stop());
      void unlisten.then((stop) => stop());
    };
  }, [pin]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 1600);
    return () => clearTimeout(timer);
  }, [notice]);

  // 发往应用壳的拖动与缩放，只保留最新的一次。新状态以帧推回来。
  const send = useRef({
    move: latestOnly((x: number, y: number) => movePin(pin, x, y)),
    zoom: latestOnly((scale: number, ax: number, ay: number) => zoomPin(pin, scale, ax, ay)),
  });

  // 滚轮缩放与 Ctrl+滚轮透明度（React 的 onWheel 是被动监听，不能阻止页面缩放，所以手动加）。
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let target: number | null = null;
    let idle = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = frame.current;
      if (!f || gesture.current || e.deltaY === 0) return;
      if (e.ctrlKey) {
        void setPinOpacity(pin, wheelOpacity(f.pin.opacity, e.deltaY));
        return;
      }
      if (f.pin.locked) return;
      const dpr = window.devicePixelRatio;
      target = wheelZoomScale(target ?? f.pin.placement.scale, e.deltaY);
      send.current.zoom(target, f.window.x + e.clientX * dpr, f.window.y + e.clientY * dpr);
      clearTimeout(idle);
      idle = window.setTimeout(() => (target = null), 300);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 不让 WebView 自己缩放页面。
      if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const turn = TURN_KEYS[e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()];
      if (!turn) return;
      e.preventDefault();
      void turnPin(pin, turn);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pin]);

  /** 指针在内容的右下角缩放区里（CSS 像素，相对窗口）。 */
  const atCorner = (x: number, y: number) => {
    const f = frame.current;
    if (!f || f.pin.locked) return false;
    const dpr = window.devicePixelRatio;
    const local = { x: x - (f.content.x - f.window.x) / dpr, y: y - (f.content.y - f.window.y) / dpr };
    return inZoomCorner(local, f.content.width / dpr, f.content.height / dpr);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (pressOpensMenu(e.pointerType, e.button)) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (e.button !== 0) return;
    const f = frame.current;
    if (!f) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = { x: e.screenX, y: e.screenY };
    const base = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      down: at,
      last: at,
      at: performance.now(),
      dragged: false,
    };
    const origin = { x: f.content.x, y: f.content.y };
    if (f.pin.locked) {
      gesture.current = { ...base, kind: "hold" };
    } else if (atCorner(e.clientX, e.clientY)) {
      const size = pinCanvasSize({ width: f.pin.width, height: f.pin.height, ...f.pin.placement }, 1);
      gesture.current = { ...base, kind: "zoom", origin, start: { scale: f.pin.placement.scale, ...size } };
    } else {
      gesture.current = { ...base, kind: "move", origin };
    }
    if (e.pointerType !== "mouse") {
      const g = gesture.current;
      setTimeout(() => {
        if (gesture.current === g && !g.dragged && heldForMenu(g.pointerType, g.down, g.last, performance.now() - g.at)) {
          openMenu();
        }
      }, HOLD_MS);
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g) {
      setCorner(atCorner(e.clientX, e.clientY));
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    g.last = { x: e.screenX, y: e.screenY };
    if (Math.hypot(g.last.x - g.down.x, g.last.y - g.down.y) > HOLD_SLOP) g.dragged = true;
    if (g.kind === "hold") return;
    const dpr = window.devicePixelRatio;
    const dx = (g.last.x - g.down.x) * dpr;
    const dy = (g.last.y - g.down.y) * dpr;
    if (g.kind === "move") {
      send.current.move(Math.round(g.origin.x + dx), Math.round(g.origin.y + dy));
    } else {
      send.current.zoom(cornerZoomScale(g.start, dx, dy), g.origin.x, g.origin.y);
    }
  };
  const endGesture = (e: PointerEvent) => {
    const g = gesture.current;
    if (g?.pointerId !== e.pointerId) return;
    gesture.current = null;
    // 拖动中动画已结束的，现在请应用壳把窗口改成静止时的矩形；还在动的，动完再请。
    settleSoon.current();
  };

  return (
    <div
      ref={host}
      className={[
        "pin",
        locked ? "pin-locked" : corner ? "pin-corner" : "",
        veiled ? "pin-veiled" : "",
      ].filter(Boolean).join(" ")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu();
      }}
    >
      <div ref={body} className="pin-content">
        <div className="pin-appear" aria-hidden />
        <div className="pin-veil" aria-hidden={!veiled}>
          {veiled && !confirming && (
            <button
              type="button"
              className="pin-veil-lock"
              aria-label="安全模式下已遮蔽，点按确认显示"
              title="安全模式下已遮蔽"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setConfirming(true)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M4 6V4.5a3 3 0 0 1 6 0V6" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <rect x="2.5" y="6" width="9" height="6.5" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          )}
          {veiled && confirming && (
            <div className="pin-veil-confirm" role="group" onPointerDown={(e) => e.stopPropagation()}>
              <span>显示这张图？</span>
              <button type="button" onClick={() => void revealPin(pin)}>显示</button>
              <button type="button" onClick={() => setConfirming(false)}>取消</button>
            </div>
          )}
        </div>
        {(unavailable || missing) && (
          <div className="pin-missing">{unavailable ?? "参考图无法读取：资料库没有打开，或原图已缺失"}</div>
        )}
        {notice && <div className="pin-notice">{notice}</div>}
      </div>
    </div>
  );
}
