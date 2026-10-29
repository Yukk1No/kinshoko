import { useEffect, useRef } from 'react';
import { OPEN_MS, SEAL_MS, clamp, sealBookSVG } from '../sealbook';

type Props = {
  sealed: boolean;
  reducedMotion: boolean;
  /** Slow-motion factor for frame-by-frame checks (#27); 1 in normal use. */
  slow: number;
  onToggle: () => void;
};

/** The safe-mode switch at the bottom of the icon rail (#27, Q100, Q108). The icon is drawn from a
 * progress value, so a click mid-animation turns back from the frame on screen instead of jumping. */
export function SealBook({ sealed, reducedMotion, slow, onToggle }: Props) {
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

  return <button className={`rail-btn seal-book${sealed ? ' is-sealed' : ''}`} aria-pressed={sealed} aria-label="安全模式" onClick={onToggle}>
    <svg ref={svg} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false" />
    <span className="tip" role="tooltip">安全模式{sealed ? '：开，成人图已封印' : '：关'}<kbd>Ctrl+Shift+S</kbd></span>
  </button>;
}
