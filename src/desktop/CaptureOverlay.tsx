import { useEffect, useRef, useState, type PointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import type { CaptureAction } from "../bindings/CaptureAction";
import type { FrozenScreen } from "../bindings/FrozenScreen";
import type { OriginalPixels } from "../bindings/OriginalPixels";
import { cancelCapture, captureReadout, captureReady, captureUrl, finishCapture, frozenScreen } from "../ipc";
import { dragSelection, editSelection, reachEdges, selectionPart, toDevicePx, type Grip, type Point, type Rect, type SelectionPart } from "./pixels";
import { Copy, Pin, X } from "lucide-react";
import { Dock } from "../ui/Dock";
import { FollowDock } from "../ui/FollowDock";
import { OriginalStar } from "../ui/OriginalStar";

/** 太小的选区多半是误点，不截。 */
const MIN_SIZE = 4;
/** 选区的边与角向内外各伸出这么多 CSS 像素都算按在上面。 */
const GRIP_REACH = 6;
/** 手柄画在四角与四边中点。 */
const HANDLES: Grip[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * 框选窗口（F1）：盖住一台显示器（让出最下面一行，不被当成全屏程序，#230），显示冻结的屏幕。拖动框选，Enter／F3／双击钉住，
 * Ctrl+C 复制，Esc 取消。有选区时与常见截图工具一样：按住选区内部拖动是移动，按住边或角是调整大小，在选区外拖动重新框选；
 * 右键先清掉选区，没有选区时再右键取消。选区下方 14 px 跟着一个 dock：读数、复制、钉住、取消（#98）。
 * 读数（#103）：选区完全落在一张登记为来源的参考图上（结果是参考视图）时为原图对应区域的原始像素，
 * 带上 logo 的星；其余情况为屏幕像素。来源在冻结时已定，遮蔽中的图不登记，按截图处理。
 *
 * 按下复制／钉住后，窗口留到结果可用才由原生端隐藏（#127）：其间 dock 换成进度、不再接受操作，
 * 读大原图要等一会儿时画师立刻看得到反馈。
 *
 * 窗口预先建好、用完只隐藏（#129）：每次会话开始或结束，原生端发 `capture-session`，页面丢掉上一次的
 * 选区，重新取冻结屏幕（结束时取到 null）。
 *
 * 坐标一律用物理像素：冻结屏幕的 CSS 尺寸 = 物理像素 / dpr，正好原位；选区来自 pointer 事件的
 * 小数坐标乘 dpr（鼠标事件只有整 CSS 像素，110% 下会差 ±1 物理像素）。
 */
export function CaptureOverlay() {
  const [screen, setScreen] = useState<FrozenScreen | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 已确认、正在等结果的动作。 */
  const [busy, setBusy] = useState<CaptureAction | null>(null);
  /** 当前选区的读数（见下）；会话变了就丢掉。 */
  const [readout, setReadout] = useState<{ rect: Rect; original: OriginalPixels | null } | null>(null);
  /** 按下时的指针位置、按在选区的哪里、当时的选区；松开后为 null。 */
  const start = useRef<{ at: Point; part: SelectionPart; rect: Rect | null } | null>(null);
  /** 指针在选区的哪里，决定光标；拖动中保持按下时的部分。 */
  const [hover, setHover] = useState<SelectionPart>("outside");
  const dpr = window.devicePixelRatio;

  useEffect(() => {
    let alive = true;
    let sequence = 0;
    // 只认最后一次请求的回复：会话结束与下一次开始可能紧挨着到达。
    const refresh = () => {
      const request = ++sequence;
      setRect(null); setDragging(false); setBusy(null); setReadout(null); setHover("outside"); start.current = null;
      void frozenScreen().then((next) => { if (alive && request === sequence) setScreen(next); });
    };
    refresh();
    const off = listen("capture-session", refresh);
    return () => { alive = false; void off.then((f) => f()); };
  }, []);

  const usable = rect !== null && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;

  // 选区每次变化都问一次读数（拖动中也问，松手时答案已到）；只认与当前选区相同的回复。
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
    if (busy) return;
    if (action === "cancel") return screen && void cancelCapture(screen.image.slice("screen/".length));
    if (!screen || !rect || !usable) return;
    setBusy(action);
    // 成功与失败都由原生端隐藏窗口并发 capture-session；这里只防止回复丢失时一直停在进度上。
    finishCapture(rect, action, screen.image.slice("screen/".length)).catch(() => setBusy(null));
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

  /** 拖动中的选区，拖到显示器边上时补到边缘（框选窗口让出了最下面一行，#230）。 */
  const drag = (previous: Rect | null, from: Point, to: Point) => {
    const next = dragSelection(previous, from, to);
    return next && next !== previous && screen ? reachEdges(next, screen) : next;
  };

  const partAt = (point: Point) => (rect ? selectionPart(rect, point, Math.round(GRIP_REACH * dpr)) : "outside");

  /** 拖动到 `to` 时的选区：选区外重新框选，内部移动，边或角调整大小。 */
  const follow = (to: Point) => {
    const gesture = start.current;
    if (!gesture) return;
    const { at: from, part, rect: before } = gesture;
    if (part === "outside" || !before || !screen) setRect((previous) => drag(previous, from, to));
    else setRect(editSelection(before, part, to.x - from.x, to.y - from.y, screen));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (busy || (e.target as HTMLElement).closest(".capture-tools")) return;
    if (e.button === 2) {
      if (!rect) return finish("cancel");
      setRect(null); setHover("outside");
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = at(e);
    const part = partAt(point);
    start.current = { at: point, part, rect };
    setHover(part);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (start.current) follow(at(e));
    else if (!busy && !(e.target as HTMLElement).closest(".capture-tools")) setHover(partAt(at(e)));
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!start.current) return;
    follow(at(e));
    start.current = null;
    setDragging(false);
  };

  if (!screen) return null;
  const css = (px: number) => `${px / dpr}px`;
  return (
    <div
      className={busy ? "capture is-busy" : "capture"}
      style={busy || hover === "outside" ? undefined : { cursor: hover === "inside" ? "move" : `${hover}-resize` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest(".capture-tools")) finish("pin"); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img
        key={screen.image}
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
          {HANDLES.map((grip) => <span key={grip} className={`capture-handle is-${grip}`} aria-hidden="true" />)}
        </div>
      )}
      {usable && !dragging && (
        <FollowDock className="capture-tools" bounds={{ width: innerWidth, height: innerHeight }}
          anchor={{ x: rect.x / dpr, y: rect.y / dpr, width: rect.width / dpr, height: rect.height / dpr }}>
          <Dock label="截图" onSelect={(id) => finish(id as CaptureAction | "cancel")}
            readout={busy
              ? <span role="status">{`正在${busy === "copy" ? "复制" : "钉住"}${original ? "原图" : ""}…`}</span>
              : original
              ? <><b>{original.width} × {original.height}</b><span className="k-original">原始像素<OriginalStar /></span></>
              : <><b>{rect.width} × {rect.height}</b>屏幕像素</>} items={[
              { id: "copy", label: "复制", icon: <Copy size={18} strokeWidth={1.75} />, shortcut: "Ctrl C", disabled: !!busy },
              { id: "pin", label: "钉住", icon: <Pin size={18} strokeWidth={1.9} />, shortcut: "Enter", tone: "primary", disabled: !!busy },
              "sep",
              { id: "cancel", label: "取消", icon: <X size={18} strokeWidth={1.75} />, shortcut: "Esc", tone: "danger", disabled: !!busy },
            ]} />
        </FollowDock>
      )}
      {!rect && <div className="capture-tip">拖动框选 · 右键取消</div>}
    </div>
  );
}
