import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Image } from "lucide-react";
import { arcSpring } from "../ui/Dock";
import { useReducedMotion } from "../ui/reducedMotion";
import { DensitySlider } from "./DensitySlider";

/**
 * 图片大小 (#102 故事15/16, 方案 C3): the size slider floats at the bottom-right of the image wall,
 * between a small and a large picture mark, so it reads as the pair of Ctrl+wheel zoom.
 * Commit behaviour is DensitySlider's: drags commit on release, keyboard steps 220 ms after the last one.
 * `preview` is the wall's Ctrl+wheel zoom (#111) in progress: the slider shows it; the wall commits it.
 * `collapsed` (#180): while the multi-select bar is up the island shrinks, like a dynamic island, to a
 * 40 px round button. Hovering or pressing it turns that button into the slider (#452): the knob's icon
 * stays put as the large mark and the shape grows left, or also up when `rise` says the left is taken
 * (`onRising` tells the corner, so that the tagging dot rides along).
 * The slot stays 40 px, so nothing around it moves, and it is what the pointer has to leave: the shape
 * can rise off the pointer. Every shape change uses the dock's morph spring; reduced motion jumps to the end state.
 */
export function DensityIsland(p: {
  value: number;
  preview?: number | null;
  onPreview: (v: number | null) => void;
  onCommit: (v: number) => void;
  collapsed?: boolean;
  rise?: boolean;
  onRising?: (rising: boolean) => void;
}) {
  const { t } = useTranslation("wall");
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  if (open && !p.collapsed) setOpen(false);
  const button = useRef<HTMLButtonElement>(null);
  const hovering = useRef(false);
  const dragging = useRef(false);
  const expanded = !p.collapsed || open;
  const rising = !!(p.collapsed && open && p.rise);
  const { onRising } = p;
  useEffect(() => {
    onRising?.(rising);
  }, [rising, onRising]);
  const large = <Image size={16} strokeWidth={1.75} data-end="large" aria-hidden="true" />;
  // A drag can end outside the slot; the pointer has left by then and only the release can close it.
  const trackDrag = () => {
    dragging.current = true;
    const end = () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dragging.current = false;
      if (!hovering.current) setOpen(false);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return (
    <div
      className="k-density-slot"
      role="group"
      aria-label={t("density.label")}
      data-collapsed={p.collapsed || undefined}
      data-rising={rising || undefined}
      onMouseEnter={() => {
        hovering.current = true;
        if (p.collapsed) setOpen(true);
      }}
      onMouseLeave={(e) => {
        hovering.current = false;
        // Someone working the keyboard keeps the slider open when the mouse happens to pass by.
        if (!dragging.current && !e.currentTarget.querySelector(":focus-visible")) setOpen(false);
      }}
      onPointerDownCapture={(e) => {
        if (e.target instanceof HTMLInputElement) trackDrag();
      }}
      onBlur={(e) => {
        if (!hovering.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      {/* The radius goes through style so that motion can keep it round while it scales the box. */}
      <motion.div
        layout={!reduced}
        layoutId={reduced ? undefined : "k-density-island"}
        transition={arcSpring.morph}
        style={{ borderRadius: 20 }}
        className="k-density-island density"
        data-open={expanded || undefined}
      >
        {p.collapsed && (
          <motion.button
            ref={button}
            layout={reduced ? false : "position"}
            transition={arcSpring.morph}
            type="button"
            className="k-density-knob"
            aria-label={t("density.label")}
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            {large}
          </motion.button>
        )}
        {/* Stays mounted while closed so that it holds its place on screen as the shape grows, instead of riding the shape's left edge. */}
        <motion.div
          layout={reduced ? false : "position"}
          className="k-density-row"
          inert={!expanded}
          aria-hidden={!expanded || undefined}
          initial={false}
          style={reduced ? { opacity: expanded ? 1 : 0 } : undefined}
          animate={reduced ? undefined : { opacity: expanded ? 1 : 0 }}
          transition={{ layout: arcSpring.morph, opacity: arcSpring.snappy }}
        >
          <Image size={12} strokeWidth={1.75} data-end="small" aria-hidden="true" />
          <DensitySlider
            label={t("density.label")}
            value={p.value}
            preview={p.preview}
            onPreview={p.onPreview}
            onCommit={p.onCommit}
          />
          {!p.collapsed && large}
        </motion.div>
      </motion.div>
    </div>
  );
}
