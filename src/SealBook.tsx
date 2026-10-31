import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { OPEN_MS, SEAL_MS, clamp, sealBookSVG } from "./shell/sealbook";
import { useReducedMotion } from "./ui/reducedMotion";

// The drawing and the progress-driven seal / release motion are copied verbatim from the approved
// prototype (bd8aea44:prototype/reference-browser/src/components/SealBook.tsx, round-5 A1 round lock).
// Only the wiring is the app's: its accessible names, and reduced motion (src/ui/reducedMotion.ts).

/**
 * 封印书：安全模式的开关（第五轮 A1 圆锁，#27）。合上的书带一把圆锁表示开启，翻开的书表示关闭。
 * 图形按进度绘制，动画中途再点会从屏幕上的那一帧折回，不会跳。快捷键 Ctrl+Shift+S 由主窗口处理。
 */
export function SealBook({ on, onToggle, slow = 1 }: { on: boolean; onToggle: () => void; slow?: number }) {
  const { t } = useTranslation("shell");
  const sealed = on;
  const reducedMotion = useReducedMotion();
  const svg = useRef<SVGSVGElement>(null);
  const motion = useRef({ p: sealed ? 0 : 1, from: sealed ? 0 : 1, at: 0, raf: 0, drawn: -1 });

  useEffect(() => {
    const m = motion.current, target = sealed ? 0 : 1;
    const draw = (p: number) => {
      if (p === m.drawn || !svg.current) return;
      svg.current.innerHTML = sealBookSVG(p);
      m.drawn = p;
    };
    cancelAnimationFrame(m.raf);
    if (reducedMotion) { m.p = target; draw(target); return; }
    m.from = m.p;
    m.at = performance.now();
    // A reversal mid-way only travels back the distance it covered.
    const ms = Math.max(1, (sealed ? SEAL_MS : OPEN_MS) * slow * Math.abs(target - m.from));
    const tick = (now: number) => {
      const t = clamp((now - m.at) / ms);
      m.p = m.from + (target - m.from) * t;
      draw(m.p);
      if (t < 1) m.raf = requestAnimationFrame(tick);
    };
    m.raf = requestAnimationFrame(tick);
    draw(m.p);
    return () => cancelAnimationFrame(m.raf);
  }, [sealed, reducedMotion, slow]);

  return <button type="button" className={`rail-btn seal-book${sealed ? " is-sealed" : ""}`} aria-pressed={sealed}
    aria-label={sealed ? t("safeMode.on") : t("safeMode.off")} onClick={onToggle}>
    <svg ref={svg} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false" />
    <span className="tip" role="tooltip">{sealed ? t("safeMode.tipOn") : t("safeMode.tipOff")}<kbd>Ctrl+Shift+S</kbd></span>
  </button>;
}
