import { useEffect, useRef, useState } from 'react';
import { LOCK_VIEWBOX, clamp, lockSVG } from '../sealbook';

const LOCK_COLOURS = { ink: 'none', acc: 'var(--seal-acc)', cut: 'none' };
const OPEN_MS = 460, CLOSE_MS = 220;

/** Blur in place over a pin (Q98). When safe mode turns off or the artist confirms, the small round lock
 * from the seal book pops open and the blur dissolves where it is, without flying (Q107). */
export function SealVeil({ sealed, reducedMotion, size = 16 }: { sealed: boolean; reducedMotion: boolean; size?: number }) {
  const [shown, setShown] = useState(sealed);
  const [leaving, setLeaving] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const q = useRef(sealed ? 0 : 1);

  useEffect(() => {
    if (sealed) { setShown(true); setLeaving(false); }
    else if (shown) setLeaving(true);
  }, [sealed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!shown) return;
    const target = sealed ? 0 : 1, from = q.current, at = performance.now();
    const ms = reducedMotion ? 0 : (sealed ? CLOSE_MS : OPEN_MS) * Math.abs(target - from);
    let raf = 0;
    const tick = (now: number) => {
      q.current = ms ? from + (target - from) * clamp((now - at) / ms) : target;
      if (svg.current) svg.current.innerHTML = lockSVG(q.current, LOCK_COLOURS);
      if (q.current !== target) raf = requestAnimationFrame(tick);
      else if (!sealed) { setShown(false); setLeaving(false); }
    };
    tick(at);
    return () => cancelAnimationFrame(raf);
  }, [sealed, shown, reducedMotion]);

  if (!shown) return null;
  return <div className={`veil seal-veil${leaving ? ' is-leaving' : ''}`}>
    <svg ref={svg} width={size * 1.6} height={size * 1.76} viewBox={LOCK_VIEWBOX} aria-hidden="true" focusable="false" />
    <span>安全模式</span>
  </div>;
}
