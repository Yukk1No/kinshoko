import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CaptureAction } from "../bindings/CaptureAction";
import type { FrozenScreen } from "../bindings/FrozenScreen";
import type { OriginalPixels } from "../bindings/OriginalPixels";
import { cancelCapture, captureReadout, captureReady, captureUrl, finishCapture, frozenScreen } from "../ipc";
import { dragSelection, toDevicePx, type Point, type Rect } from "./pixels";
import { Copy, Pin, X } from "lucide-react";
import { Dock } from "../ui/Dock";
import { FollowDock } from "../ui/FollowDock";
import { OriginalStar } from "../ui/OriginalStar";

/** 太小的选区多半是误点，不截。 */
const MIN_SIZE = 4;

/**
 * 框选窗口（F1）：铺满一台显示器，显示冻结的屏幕。拖动框选，Enter／F3／双击钉住，
 * Ctrl+C 复制，Esc 或右键取消。选区下方 14 px 跟着一个 dock：读数、复制、钉住、取消（#98）。
 * 读数（#103）：选区完全落在一张登记为来源的参考图上（结果是参考视图）时为原图对应区域的原始像素，
 * 带上 logo 的星；其余情况为屏幕像素。来源在冻结时已定，遮蔽中的图不登记，按截图处理。
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
    frozenScreen().then(setScreen);
  }, []);

  const usable = rect !== null && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;

  // 选区每次变化都问一次读数（拖动中也问，松手时答案已到）；只认与当前选区相同的回复。
  const [readout, setReadout] = useState<{ rect: Rect; original: OriginalPixels | null } | null>(null);
  useEffect(() => {
    if (!screen || !rect || !usable) return;
    let alive = true;
    const settle = (original: OriginalPixels | null) => { if (alive) setReadout({ rect, original }); };
    captureReadout(rect, screen.image.slice("screen/".length)).then(settle, () => settle(null));
    return () => { alive = false; };
  }, [screen, rect, usable]);
  const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const original = readout && rect && same(readout.rect, rect) ? readout.original : null;

  const finish = (action: CaptureAction | "cancel") => {
    if (action === "cancel") return screen && void cancelCapture(screen.image.slice("screen/".length));
    if (!screen || !rect || !usable) return;
    void finishCapture(rect, action, screen.image.slice("screen/".length));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 聚焦在 dock 按钮上时，Enter／空格只执行那个按钮。
      if ((e.key === "Enter" || e.key === " ") && (e.target as Element | null)?.closest?.(".capture-tools button")) return;
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
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest(".capture-tools")) finish("pin"); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img
        className="capture-screen"
        alt=""
        draggable={false}
        src={captureUrl(screen.image)}
        style={{ width: css(screen.width), height: css(screen.height) }}
        onLoad={() => void captureReady(screen.image.slice("screen/".length))}
        onError={() => void cancelCapture(screen.image.slice("screen/".length))}
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
          {(["tl", "tr", "bl", "br"] as const).map((corner) => <span key={corner} className={`capture-handle is-${corner}`} aria-hidden="true" />)}
        </div>
      )}
      {usable && !dragging && (
        <FollowDock className="capture-tools" bounds={{ width: innerWidth, height: innerHeight }}
          anchor={{ x: rect.x / dpr, y: rect.y / dpr, width: rect.width / dpr, height: rect.height / dpr }}>
          <Dock label="截图" onSelect={(id) => finish(id as CaptureAction | "cancel")}
            readout={original
              ? <><b>{original.width} × {original.height}</b><span className="k-original">原始像素<OriginalStar /></span></>
              : <><b>{rect.width} × {rect.height}</b>屏幕像素</>} items={[
              { id: "copy", label: "复制", icon: <Copy size={18} strokeWidth={1.75} />, shortcut: "Ctrl C" },
              { id: "pin", label: "钉住", icon: <Pin size={18} strokeWidth={1.9} />, shortcut: "Enter", tone: "primary" },
              "sep",
              { id: "cancel", label: "取消", icon: <X size={18} strokeWidth={1.75} />, shortcut: "Esc", tone: "danger" },
            ]} />
        </FollowDock>
      )}
      {!rect && <div className="capture-tip">拖动框选 · 右键取消</div>}
    </div>
  );
}
