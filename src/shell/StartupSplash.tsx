import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStartupGate } from "../startupGate";
import { I_STAR } from "../ui/OriginalStar";
import { useReducedMotion } from "../ui/reducedMotion";
import { WinCtrls } from "../ui/WinCtrls";

// 竖排字标，原样取自 design/logo-kit/lockups/vertical-*.svg（viewBox 0 0 798 487）；颜色走令牌。
const BOOKMARK = "M82 20 H174 A18 18 0 0 1 192 38 V236 L128 192 L64 236 V38 A18 18 0 0 1 82 20 Z M116 117.8 A26 26 0 1 1 140 117.8 L147 158 H109 Z";
const LETTERS = [
  "M30 44 V200", "M96 104 L34 156", "M62 134 L100 200", "M132 108 V200",
  "M168 200 V108 M168 146 A32 32 0 0 1 232 146 V200",
  "M314 120 C306 104 268 98 266 124 C264 148 318 146 318 174 C318 204 274 206 262 186",
  "M352 44 V200 M352 146 A32 32 0 0 1 416 146 V200", "M444 154 A46 46 0 1 0 536 154 A46 46 0 1 0 444 154 Z",
  "M568 44 V200", "M634 104 L572 156", "M600 134 L638 200", "M670 154 A46 46 0 1 0 762 154 A46 46 0 1 0 670 154 Z",
];
const LOCKUP_W = 798;
/** 星在竖排字标里的中心（字标组平移 3 254 之后）。 */
const STAR_AT = { x: 135, y: 312 };
/** 星的形状，相对中心：四个尖与四条边的控制点（I_STAR 的同一几何）。 */
const STAR_TIPS = [[0, -26], [26, 0], [0, 26], [-26, 0]];
const STAR_CTRL = [[4.16, -4.16], [4.16, 4.16], [-4.16, 4.16], [-4.16, -4.16]];
/** 星沿 45° 方向最窄处到中心的距离（单位同上）：放大到这里盖住窗口角落才算铺满。 */
const STAR_WAIST = 12.1;

// 背景的淡瀑布流：七列，相邻列反向漂动。
const COLUMNS = [
  [210, 150, 260, 180, 230, 140, 200], [160, 240, 190, 150, 270, 200, 170], [250, 180, 140, 220, 160, 240, 190],
  [180, 220, 260, 150, 200, 170, 230], [230, 160, 200, 250, 140, 210, 180], [150, 260, 180, 210, 230, 160, 240],
  [200, 170, 240, 160, 190, 250, 150],
];
const TONES = [0.75, 0.55, 1, 0.65, 0.9];

const POP_MS = 250;
const GROW_MS = 900;
const FADE_MS = 200;
/** 退场前要连续这么多帧、每帧都短于 SMOOTH_FRAME_MS，才算主线程空下来了。 */
const SMOOTH_FRAMES = 4;
const SMOOTH_FRAME_MS = 34;
const SETTLE_MAX_MS = 800;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const inOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const outBack = (u: number) => 1 + 2.9 * (u - 1) ** 3 + 1.9 * (u - 1) ** 2;

/** 星形开口：窗口外框减去旋转、放大的星（evenodd），开口里露出下面的主界面。 */
function starHole(width: number, height: number, cx: number, cy: number, scale: number, degrees: number) {
  const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const points: string[] = [];
  for (let e = 0; e < 4; e++) {
    const [p0, c, p1] = [STAR_TIPS[e], STAR_CTRL[e], STAR_TIPS[(e + 1) % 4]];
    for (let i = 0; i < 10; i++) {
      const u = i / 10, w0 = (1 - u) ** 2, w1 = 2 * u * (1 - u), w2 = u * u;
      const x = w0 * p0[0] + w1 * c[0] + w2 * p1[0], y = w0 * p0[1] + w1 * c[1] + w2 * p1[1];
      points.push(`${(cx + (x * cos - y * sin) * scale).toFixed(1)} ${(cy + (x * sin + y * cos) * scale).toFixed(1)}`);
    }
  }
  return `path(evenodd, "M0 0H${width}V${height}H0Z M${points.join(" L")}Z")`;
}

/**
 * 启动加载页（#338）：盖在主界面上，等资料库打开、图片墙第一页与首屏缩略图（最多 5 秒，见 startupGate）。
 * 只有字标、进度条和背景的淡瀑布流，不写字。放行时字标上的星旋转放大，主界面从星形开口里展开；
 * “减少动画”时直接淡出。
 */
export function StartupSplash() {
  const { t } = useTranslation("shell");
  const { progress, released } = useStartupGate();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<"loading" | "settling" | "leaving" | "gone">("loading");
  const root = useRef<HTMLDivElement>(null);
  const logo = useRef<SVGSVGElement>(null);
  const star = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    if (released && phase === "loading") setPhase(reduced ? "leaving" : "settling");
  }, [released, phase, reduced]);

  // 放行时主界面正在首次渲染、接收缩略图，主线程有几帧上百毫秒（#338 现场测得）：等它连续几帧顺畅了再退场，
  // 免得星星一跳一跳；最多多等 SETTLE_MAX_MS。
  useEffect(() => {
    if (phase !== "settling") return;
    let frame = 0, smooth = 0, last = 0, since = -1;
    const tick = (now: number) => {
      if (since < 0) since = now;
      smooth = last && now - last < SMOOTH_FRAME_MS ? smooth + 1 : 0;
      last = now;
      if (smooth >= SMOOTH_FRAMES || now - since > SETTLE_MAX_MS) setPhase("leaving");
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase !== "leaving") return;
    performance.mark?.("startup-exit-start");
    const overlay = root.current, mark = logo.current, glyph = star.current;
    if (reduced || !overlay || !mark || !glyph) {
      const timer = setTimeout(() => setPhase("gone"), FADE_MS);
      return () => clearTimeout(timer);
    }
    const box = overlay.getBoundingClientRect(), at = mark.getBoundingClientRect();
    const s0 = at.width / LOCKUP_W;
    const cx = at.left - box.left + STAR_AT.x * s0, cy = at.top - box.top + STAR_AT.y * s0;
    const far = Math.max(...[[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const end = (far / (STAR_WAIST * s0)) * 1.08;
    // 时间都取帧时间戳：从第一帧算起。
    let frame = 0, started = -1;
    const step = (now: number) => {
      if (started < 0) started = now;
      const t = now - started;
      const pop = clamp(t / POP_MS), grow = clamp((t - POP_MS) / GROW_MS);
      const k = (1 + 0.35 * outBack(pop) * (1 - grow)) * Math.exp(Math.log(end) * grow ** 3);
      const rot = -20 * pop + 200 * inOut(grow);
      glyph.setAttribute("transform", `translate(132 58) rotate(${rot.toFixed(2)}) scale(${k.toFixed(4)}) translate(-132 -58)`);
      if (t >= POP_MS) overlay.style.clipPath = starHole(box.width, box.height, cx, cy, s0 * k, rot);
      if (grow < 1) frame = requestAnimationFrame(step);
      else { performance.mark?.("startup-exit-end"); setPhase("gone"); }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [phase, reduced]);

  if (phase === "gone") return null;
  return <div ref={root} className="startup-splash" data-phase={phase} data-reduced={reduced || undefined}
    role="status" aria-label={t("openingLabel")} aria-busy={phase === "loading"}>
    <div className="startup-wall" aria-hidden="true">
      {COLUMNS.map((heights, i) => <div key={i} className="startup-col">
        <div className={`startup-col-run ${i % 2 ? "is-down" : "is-up"}`} style={{ animationDuration: `${(70 + ((i * 13) % 30)) / 3}s` }}>
          {[...heights, ...heights].map((h, j) => <span key={j} style={{ height: h, opacity: TONES[(i + j) % TONES.length] }} />)}
        </div>
      </div>)}
    </div>
    <header className="startup-head" data-tauri-drag-region><WinCtrls /></header>
    <div className="startup-center" data-tauri-drag-region>
      <svg ref={logo} className="startup-logo" viewBox="0 0 798 487" aria-hidden="true" focusable="false">
        <g className="startup-logo-rest">
          <path className="startup-ink-fill" fillRule="evenodd" transform="translate(271 2)" d={BOOKMARK} />
          <g transform="translate(3 254)" className="startup-ink-stroke">{LETTERS.map((d) => <path key={d} d={d} />)}</g>
        </g>
        <g transform="translate(3 254)"><g ref={star}><path className="startup-star" d={I_STAR} /></g></g>
      </svg>
      <div className="startup-bar" aria-hidden="true" data-progress={Math.round(progress * 100)}>
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  </div>;
}
