// Reused from bd8aea44:prototype/reference-browser/src/components/DensitySlider.tsx.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

const MIN = 140;
const MAX = 420;

/** Accepted slider gestures and delayed keyboard commit; the formal Wall measures its current cards
 * before each preview, then updates the real layout without requesting thumbnails until commit. */
export function DensitySlider(p: { value: number; preview?: number | null; onPreview: (v: number | null) => void; onCommit: (v: number) => void; showValue?: boolean; label?: string }) {
  const [v, setV] = useState(p.value);
  const timer = useRef(0);
  const dragging = useRef(false);
  const pending = useRef<number | null>(null);
  useEffect(() => setV(p.value), [p.value]);
  // Ctrl+wheel zoom on the wall previews the same value (#111): the thumb follows it; the wall commits it itself.
  useEffect(() => { setV(p.preview ?? p.value); }, [p.preview]);
  const commit = (x: number) => {
    clearTimeout(timer.current);
    dragging.current = false;
    pending.current = null;
    if (x === p.value) p.onPreview(null); else p.onCommit(x);
  };
  // Closing the settings dialog mid-pause (Esc) still lands the size the artist chose.
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => { clearTimeout(timer.current); if (pending.current !== null) latest.current(pending.current); }, []);
  // The travelled part of the track is painted from --fill (a native range has no pseudo-element for it).
  const fill = `${((v - MIN) / (MAX - MIN)) * 100}%`;
  const input = <input type="range" className="k-range" min={MIN} max={MAX} step={10} value={v} aria-label={p.label}
    style={{ "--fill": fill } as CSSProperties}
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
