import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CaptureAction } from "../bindings/CaptureAction";
import type { FrozenScreen } from "../bindings/FrozenScreen";
import { cancelCapture, captureReady, captureUrl, finishCapture, frozenScreen } from "../ipc";
import { dragSelection, toDevicePx, type Point, type Rect } from "./pixels";

/** 太小的选区多半是误点，不截。 */
const MIN_SIZE = 4;

/**
 * 框选窗口（F1）：铺满一台显示器，显示冻结的屏幕。拖动框选，Enter／F3／双击钉住，
 * Ctrl+C 复制，Esc 或右键取消。
 *
 * 坐标一律用物理像素：冻结屏幕的 CSS 尺寸 = 物理像素 / dpr，正好原位；选区来自 pointer 事件的
 * 小数坐标乘 dpr（鼠标事件只有整 CSS 像素，110% 下会差 ±1 物理像素）。
 */
export function CaptureOverlay() {
  const [screen, setScreen] = useState<FrozenScreen | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const start = useRef<Point | null>(null);
  const dpr = window.devicePixelRatio;

  useEffect(() => {
    frozenScreen().then((s) => (s ? setScreen(s) : cancelCapture()));
  }, []);

  const usable = rect !== null && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;

  const finish = (action: CaptureAction | "cancel") => {
    if (action === "cancel") return void cancelCapture();
    if (!rect || !usable) return;
    void finishCapture(rect, action);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish("cancel");
      else if (e.key === "Enter" || e.key === "F3") finish("pin");
      else if (e.ctrlKey && e.key.toLowerCase() === "c") finish("copy");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const at = (e: PointerEvent): Point => ({
    x: toDevicePx(e.clientX, dpr),
    y: toDevicePx(e.clientY, dpr),
  });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".capture-tools")) return;
    if (e.button === 2) return finish("cancel");
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = at(e);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    const from = start.current;
    if (from) setRect((previous) => dragSelection(previous, from, at(e)));
  };
  const onPointerUp = (e: PointerEvent) => {
    const from = start.current;
    if (!from) return;
    setRect((previous) => dragSelection(previous, from, at(e)));
    start.current = null;
    setDragging(false);
  };

  if (!screen) return null;
  const css = (px: number) => `${px / dpr}px`;
  return (
    <div
      className="capture"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => finish("pin")}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img
        className="capture-screen"
        alt=""
        draggable={false}
        src={captureUrl(screen.image)}
        style={{ width: css(screen.width), height: css(screen.height) }}
        onLoad={() => void captureReady()}
        onError={() => void cancelCapture()}
      />
      {!rect && <div className="capture-shade" />}
      {rect && (
        <div
          className="capture-selection"
          style={{
            left: css(rect.x),
            top: css(rect.y),
            width: css(rect.width),
            height: css(rect.height),
          }}
        >
          <span className="capture-size">
            {rect.width} × {rect.height}
          </span>
        </div>
      )}
      {usable && !dragging && (
        <div
          className="capture-tools"
          style={{
            left: `${Math.max(4, Math.min(innerWidth - 220, (rect.x + rect.width) / dpr - 210))}px`,
            top: `${Math.min(innerHeight - 40, (rect.y + rect.height) / dpr + 8)}px`,
          }}
        >
          <button type="button" className="primary" title="Enter／F3／双击" onClick={() => finish("pin")}>
            钉住
          </button>
          <button type="button" title="Ctrl+C" onClick={() => finish("copy")}>
            复制
          </button>
          <button type="button" title="Esc／右键" onClick={() => finish("cancel")}>
            取消
          </button>
        </div>
      )}
      {!rect && <div className="capture-tip">拖动框选区域 · Enter 钉住 · Ctrl+C 复制 · Esc 取消</div>}
    </div>
  );
}
