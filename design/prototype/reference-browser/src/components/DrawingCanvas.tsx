import { useEffect, useRef } from 'react';

/** A blank sheet standing in for the drawing app, so pins can be felt "above the canvas".
 * After F4 the next stroke lands here without a click, as the edge-hide gate asks (#7). */
export function DrawingCanvas({ onExit }: { onExit: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const img = c.width ? c.getContext('2d')!.getImageData(0, 0, c.width, c.height) : null;
      c.width = Math.round(r.width * devicePixelRatio);
      c.height = Math.round(r.height * devicePixelRatio);
      if (img) c.getContext('2d')!.putImageData(img, 0, 0);
    };
    fit();
    c.focus();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const last = useRef<{ x: number; y: number } | null>(null);
  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!(e.buttons & 1)) { last.current = null; return; }
    const c = e.currentTarget, ctx = c.getContext('2d')!;
    const x = e.nativeEvent.offsetX * devicePixelRatio, y = e.nativeEvent.offsetY * devicePixelRatio;
    ctx.strokeStyle = '#2B2747';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.5, (e.pressure || 0.5) * 4) * devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(last.current?.x ?? x, last.current?.y ?? y);
    ctx.lineTo(x, y);
    ctx.stroke();
    last.current = { x, y };
  };
  return <div className="drawing">
    <canvas ref={ref} className="drawing-canvas" tabIndex={-1} aria-label="模拟画布" onPointerDown={draw} onPointerMove={draw} onPointerUp={() => { last.current = null; }} />
    <p className="drawing-hint">模拟画布：钉图浮在上层。F4 贴边隐藏后直接下笔 · <button className="link" onClick={onExit}>回到 Kinshoko（Esc）</button></p>
  </div>;
}
