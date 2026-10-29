import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { followPlacement, type Box, type Size } from "./followPlacement";

/** Positions its child (a Dock) after the selection `anchor`, measured from the real layout. */
export function FollowDock({ anchor, bounds, reserveBottom, className = "", children }: {
  anchor: Box; bounds: Size; reserveBottom?: number; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && (el.offsetWidth !== size.width || el.offsetHeight !== size.height)) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  });
  const { left, top } = followPlacement(anchor, bounds, size, { reserveBottom });
  return <div ref={ref} className={`k-follow-dock ${className}`} style={{ left, top }}>{children}</div>;
}
