import { useEffect, useRef, useState } from 'react';

/** Dragging zooms the laid-out wall (cheap, continuous, no reshuffle); letting go relayouts once and the cards
 * glide from the zoomed spots to their new places. Keys and wheel commit after a short pause. */
export function DensitySlider(p: { value: number; onPreview: (v: number | null) => void; onCommit: (v: number) => void; showValue?: boolean }) {
  const [v, setV] = useState(p.value);
  const timer = useRef(0);
  const dragging = useRef(false);
  const pending = useRef<number | null>(null);
  useEffect(() => setV(p.value), [p.value]);
  const commit = (x: number) => {
    clearTimeout(timer.current);
    dragging.current = false;
    pending.current = null;
    if (x === p.value) p.onPreview(null); else p.onCommit(x);
  };
  // Closing the settings dialog mid-pause (Esc) still lands the size the artist chose.
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => { if (pending.current !== null) latest.current(pending.current); }, []);
  const input = <input type="range" min={140} max={420} step={10} value={v}
    onPointerDown={() => { dragging.current = true; }}
    onChange={(e) => {
      const x = Number(e.target.value);
      setV(x);
      pending.current = x;
      p.onPreview(x);
      clearTimeout(timer.current);
      if (!dragging.current) timer.current = window.setTimeout(() => commit(x), 220);
    }}
    onPointerUp={(e) => commit(Number(e.currentTarget.value))}
    onPointerCancel={(e) => commit(Number(e.currentTarget.value))}
    onBlur={(e) => { if (Number(e.currentTarget.value) !== p.value) commit(Number(e.currentTarget.value)); }} />;
  return p.showValue ? <>{input}<span className="tabular">{v}px</span></> : input;
}
