import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";
import { Tip } from "./Tip";

/** Matches `--t-slow` in tokens.css: how long a slide lasts, so a resize during it keeps animating. */
const SLIDE_MS = 260;

/**
 * Segmented switch (Base UI ToggleGroup, single choice) on the sunken track. `value` null means no
 * segment is chosen yet; choosing the pressed segment again keeps it (no deselect).
 *
 * The chosen segment is marked by one thumb that slides from the old segment to the new one
 * (design/ui-system/visual-and-motion.md, 指示块). It is placed by measuring the chosen segment, so
 * segments may differ in width. It only slides when the choice changes: the first placement and
 * resizes land at once.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  options: { value: T; label: ReactNode; icon?: ReactNode; disabled?: boolean; tip?: string; ariaLabel?: string }[];
}) {
  const group = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const index = value === null ? -1 : options.findIndex((option) => option.value === value);
  const placed = useRef(-1);
  const slidingUntil = useRef(0);
  const place = useRef((_slide: boolean) => {});
  place.current = (slide) => {
    const mark = thumb.current;
    const item = group.current?.querySelectorAll<HTMLElement>(".k-seg-item")[index];
    if (!mark) return;
    if (!item) {
      mark.hidden = true;
      return;
    }
    mark.style.transition = slide ? "" : "none";
    mark.style.width = `${item.offsetWidth}px`;
    mark.style.height = `${item.offsetHeight}px`;
    mark.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
    mark.hidden = false;
  };

  useLayoutEffect(() => {
    const slide = placed.current >= 0 && index >= 0 && placed.current !== index;
    if (slide) slidingUntil.current = performance.now() + SLIDE_MS;
    place.current(slide);
    placed.current = index;
  }, [index]);

  // Segments change size with the panel, the font and their own content: follow without sliding,
  // unless a slide is under way, which then heads for the new place.
  // biome-ignore lint/correctness/useExhaustiveDependencies(options.length): a different set of segments is observed anew
  useEffect(() => {
    const root = group.current;
    if (!root) return;
    const observer = new ResizeObserver(() => place.current(performance.now() < slidingUntil.current));
    observer.observe(root);
    for (const item of root.querySelectorAll(".k-seg-item")) observer.observe(item);
    return () => observer.disconnect();
  }, [options.length]);

  return (
    <ToggleGroup
      ref={group}
      className={`k-seg ${className}`}
      aria-label={label}
      value={value === null ? [] : [value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange(picked);
      }}
    >
      <span ref={thumb} className="k-seg-thumb" aria-hidden="true" hidden />
      {options.map((option) => (
        <Tip key={option.value} label={option.tip}>
          <Toggle value={option.value} className="k-seg-item" disabled={option.disabled} aria-label={option.ariaLabel}>
            {option.icon}
            <span className="k-label">{option.label}</span>
          </Toggle>
        </Tip>
      ))}
    </ToggleGroup>
  );
}
