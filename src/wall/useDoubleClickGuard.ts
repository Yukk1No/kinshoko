// 双击按第一下的图判定（#179），从 Wall.tsx 原样搬出。
import { useEffect, useRef } from "react";
import { doubleClickSettings, isSecondPress, loadDoubleClickSettings, type Press } from "./doubleClick";

export function useDoubleClickGuard() {
  /**
   * 双击按第一下的图判定（#179）：单击卡片后记下这一下；系统双击间隔内、判定矩形内的下一次按下，
   * 无论落在另一张卡片、空白处还是正在展开的详情侧栏上，都在整个窗口的捕获阶段拦下，打开第一下的那张，
   * 不改选择，落点元素也收不到这次按下与单击。
   */
  const pendingClick = useRef<(Press & { id: string; opened: boolean }) | null>(null);
  /** 最近一次按下（窗口捕获阶段记下），单击卡片时作为第一下的时刻与位置。 */
  const lastPress = useRef<Press | null>(null);
  const openById = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    void loadDoubleClickSettings();
    let swallowing = false;
    let release = 0;
    const down = (e: PointerEvent) => {
      const press = { at: performance.now(), x: e.clientX, y: e.clientY };
      const first = pendingClick.current;
      pendingClick.current = null;
      swallowing = false;
      lastPress.current = press;
      if (!first || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!isSecondPress(first, press, doubleClickSettings(), window.devicePixelRatio || 1)) return;
      lastPress.current = null;
      e.preventDefault();
      e.stopImmediatePropagation();
      // 同一次按下随后的鼠标事件、单击与浏览器自己的双击都不交给落点；按住不放也一样，直到松开后的单击。
      // 万一单击始终没来（按下后指针被别处捕获），几秒后不再拦。
      swallowing = true;
      clearTimeout(release);
      release = window.setTimeout(() => { swallowing = false; }, 5000);
      if (!first.opened) openById.current(first.id);
    };
    const swallow = (e: Event) => {
      if (!swallowing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // 浏览器的 dblclick 紧跟着 click 在同一个任务里派发；之后的事件（例如键盘触发的单击）照常。
      if (e.type === "click") { clearTimeout(release); release = window.setTimeout(() => { swallowing = false; }, 0); }
    };
    const types = ["mousedown", "pointerup", "mouseup", "click", "dblclick"] as const;
    window.addEventListener("pointerdown", down, true);
    for (const type of types) window.addEventListener(type, swallow, true);
    return () => {
      clearTimeout(release);
      window.removeEventListener("pointerdown", down, true);
      for (const type of types) window.removeEventListener(type, swallow, true);
    };
  }, []);
  return { pendingClick, lastPress, openById };
}
