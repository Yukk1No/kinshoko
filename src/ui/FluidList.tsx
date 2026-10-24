import { createContext, useContext, useRef, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useFluidHover, useRegisterFluidHoverItem } from "./vendor/fluid/use-fluid-hover";
import { spring } from "./vendor/fluid/springs";

type Register = (index: number, element: HTMLElement | null) => void;
const Registry = createContext<Register | undefined>(undefined);

/**
 * Fluid hover (fluid-functionalism): one highlight glides to the row nearest the pointer inside the
 * list, and a click in the gaps lands on the highlighted row. Rows join with `<FluidRow index>`; the
 * index is the row's visible order, so a tree passes its pre-order position.
 */
export function FluidList({ children, className = "", gapClick = true }: { children: ReactNode; className?: string; gapClick?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { activeIndex, itemRects, isMeasured, handlers, registerItem } = useFluidHover(ref, { gapClick });
  const rect = activeIndex !== null ? itemRects[activeIndex] : undefined;
  return <div ref={ref} className={`k-fluid ${className}`} {...handlers}>
    {isMeasured && rect && <motion.span className="k-fluid-pill" aria-hidden="true" initial={false}
      animate={{ top: rect.top, height: rect.height }} transition={reduced ? { duration: 0 } : spring.moderate} />}
    <Registry.Provider value={registerItem}>{children}</Registry.Provider>
  </div>;
}

export function FluidRow({ index, children, className = "" }: { index: number; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(useContext(Registry), index, ref);
  return <div ref={ref} className={`k-fluid-row ${className}`}>{children}</div>;
}
