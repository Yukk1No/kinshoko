import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useFluidHover, useRegisterFluidHoverItem } from "./vendor/fluid/use-fluid-hover";
import { spring } from "./motion";

type Register = (index: number, element: HTMLElement | null) => void;
const Registry = createContext<Register | undefined>(undefined);

/**
 * Fluid hover (fluid-functionalism): one highlight glides to the row nearest the pointer inside the
 * list, and a click in the gaps lands on the highlighted row. Rows join with `<FluidRow index>`; the
 * index is the row's visible order, so a tree passes its pre-order position.
 */
export function FluidList({
  children,
  className = "",
  gapClick = true,
  indented = false,
  layoutKey,
}: {
  children: ReactNode;
  className?: string;
  gapClick?: boolean;
  /** 行按层级缩进（左栏的文件夹树，#608）：高亮块跟着行的左边与宽度，不铺满整个列表。 */
  indented?: boolean;
  /**
   * 行以外的内容（参考组展开的成员）挪动了行、列表总高却没变时，尺寸观察收不到通知：换一个值让高亮重新量各行位置。
   */
  layoutKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { activeIndex, itemRects, isMeasured, handlers, registerItem, remeasure } = useFluidHover(ref, { gapClick });
  useEffect(() => {
    if (layoutKey !== undefined) remeasure();
  }, [layoutKey, remeasure]);
  const rect = activeIndex !== null ? itemRects[activeIndex] : undefined;
  return (
    <div ref={ref} className={`k-fluid ${className}`} {...handlers}>
      {isMeasured && rect && (
        <motion.span
          className="k-fluid-pill"
          aria-hidden="true"
          initial={false}
          style={indented ? { right: "auto" } : undefined}
          animate={
            indented
              ? { top: rect.top, height: rect.height, left: rect.left, width: rect.width }
              : { top: rect.top, height: rect.height }
          }
          transition={reduced ? { duration: 0 } : spring.moderate}
        />
      )}
      <Registry value={registerItem}>{children}</Registry>
    </div>
  );
}

export function FluidRow({
  index,
  children,
  className = "",
}: {
  index: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(useContext(Registry), index, ref);
  return (
    <div ref={ref} className={`k-fluid-row ${className}`}>
      {children}
    </div>
  );
}
