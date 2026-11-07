import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { arcSpring } from "./Dock";
import { reducedNow, useReducedMotion } from "./reducedMotion";

/**
 * 对话框里会变高的那一段（#453）。放在标题与底部按钮之间：高度从旧值过渡到新值，`.k-dialog` 靠 translate
 * 居中，上下边缘于是对称移动，标题与按钮跟着边缘走。内容超出对话框的 max-height 时这一段滚动，高度停在上限。
 * 空闲时高度是 auto，只有过渡期间才写像素值。`className` 给需要自己定内边距的场合（设置页）。
 */
export function DialogHeight({ children, className = "" }: { children: ReactNode; className?: string }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    let natural = inner.offsetHeight;
    let settled = outer.offsetHeight;
    const moving = () => outer.hasAttribute("data-moving");
    const rest = () => {
      outer.removeAttribute("data-moving");
      outer.style.height = "";
      settled = outer.offsetHeight;
    };

    // 只观察内层：改外层高度不改内层大小，不会让 ResizeObserver 在同一帧里再报一轮。
    const observer = new ResizeObserver(() => {
      if (inner.offsetHeight === natural) return;
      natural = inner.offsetHeight;
      const from = moving() ? outer.offsetHeight : settled;
      rest();
      // rest() 量到的已经算上对话框的 max-height：停在上限时 from 与 to 相同，不过渡。
      const to = settled;
      if (reducedNow() || Math.abs(to - from) < 1) return;
      outer.style.height = `${from}px`;
      void outer.offsetHeight;
      outer.setAttribute("data-moving", "");
      outer.style.height = `${to}px`;
    });
    const ended = (event: TransitionEvent) => {
      if (event.target === outer && event.propertyName === "height") rest();
    };
    const resized = () => { if (!moving()) settled = outer.offsetHeight; };
    observer.observe(inner);
    outer.addEventListener("transitionend", ended);
    window.addEventListener("resize", resized);
    return () => {
      observer.disconnect();
      outer.removeEventListener("transitionend", ended);
      window.removeEventListener("resize", resized);
    };
  }, []);

  return <div ref={outerRef} className={`k-dialog-height ${className}`.trimEnd()}>
    <div ref={innerRef} className="k-dialog-height-inner">{children}</div>
  </div>;
}

/** 正在退场的旧内容不再接受焦点，也不再被读屏读到。 */
function LeavingInert({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return <div className="k-dialog-swap-page" inert={!present} aria-hidden={present ? undefined : true}>{children}</div>;
}

type SwapMotion = { axis: "x" | "y"; sign: number };
const SHIFT = 8;
const shifted = ({ axis }: SwapMotion, by: number) => (axis === "x" ? { x: by } : { y: by });
const swapVariants = {
  enter: (swap: SwapMotion) => ({ opacity: 0, ...shifted(swap, swap.sign * SHIFT) }),
  shown: { opacity: 1, x: 0, y: 0 },
  // 旧内容按 --t-fast 退得比新内容进得快，两页文字不长时间叠在一起。
  leave: (swap: SwapMotion) => ({ opacity: 0, ...shifted(swap, -swap.sign * SHIFT), transition: { duration: 0.12 } }),
};

/**
 * 换步骤时内容交替：`step` 变大算前进，新内容从前进方向进来，旧内容往反方向退出；变小反过来。
 * `axis` 是位移方向：向导横向（默认），设置页签这样上下排列的传 "y"。放在 DialogHeight 里，高度由它过渡。
 * 外面滚动过时，新内容从顶部开始，退场的旧内容留在原来看到的位置。
 */
export function DialogSwap({ step, axis = "x", children }: { step: number; axis?: "x" | "y"; children: ReactNode }) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const previous = useRef(step);
  const sign = useRef(1);
  if (step !== previous.current) {
    sign.current = step > previous.current ? 1 : -1;
    previous.current = step;
  }
  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>(".k-dialog-height");
    if (!scroller?.scrollTop) return;
    const scrolled = scroller.scrollTop;
    scroller.scrollTop = 0;
    rootRef.current!.querySelectorAll<HTMLElement>(":scope > .k-dialog-swap-step > [inert]").forEach((leaving) => { leaving.style.translate = `0 ${-scrolled}px`; });
  }, [step]);
  if (reduced) return <div ref={rootRef} className="k-dialog-swap"><div key={step} className="k-dialog-swap-page">{children}</div></div>;
  const custom: SwapMotion = { axis, sign: sign.current };
  return <div ref={rootRef} className="k-dialog-swap">
    <AnimatePresence mode="popLayout" initial={false} custom={custom}>
      <motion.div key={step} className="k-dialog-swap-step" custom={custom} variants={swapVariants}
        initial="enter" animate="shown" exit="leave" transition={arcSpring.snappy}>
        <LeavingInert>{children}</LeavingInert>
      </motion.div>
    </AnimatePresence>
  </div>;
}
