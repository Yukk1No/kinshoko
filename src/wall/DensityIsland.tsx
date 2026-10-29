import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
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
 * 40 px round button; hovering or pressing it pops the slider out above. The shape change uses the
 * dock's morph spring; reduced motion jumps to the end state.
 */
export function DensityIsland(p: { value: number; preview?: number | null; onPreview: (v: number | null) => void; onCommit: (v: number) => void; collapsed?: boolean }) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const slider = <DensitySlider label="图片大小" value={p.value} preview={p.preview} onPreview={p.onPreview} onCommit={p.onCommit} />;
  const morph = reduced ? { duration: 0 } : arcSpring.morph;
  if (!p.collapsed) {
    return <motion.div layout layoutId="k-density-island" transition={morph} className="k-density-island density" role="group" aria-label="图片大小">
      <Image size={12} strokeWidth={1.75} data-end="small" aria-hidden="true" />
      {slider}
      <Image size={16} strokeWidth={1.75} data-end="large" aria-hidden="true" />
    </motion.div>;
  }
  return <motion.div layout layoutId="k-density-island" transition={morph} className="k-density-island density is-collapsed" role="group" aria-label="图片大小"
    onMouseEnter={() => setOpen(true)}
    onMouseLeave={(e) => { if (!e.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
    <button ref={button} type="button" className="k-density-knob" aria-label="图片大小" aria-expanded={open} onClick={() => setOpen(true)}>
      <Image size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <AnimatePresence>
      {open && <motion.div className="k-density-pop" initial={{ opacity: 0, y: reduced ? 0 : 6, scale: reduced ? 1 : 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={reduced ? { duration: 0 } : arcSpring.smooth}>
        <Image size={12} strokeWidth={1.75} data-end="small" aria-hidden="true" />
        {slider}
        <Image size={16} strokeWidth={1.75} data-end="large" aria-hidden="true" />
      </motion.div>}
    </AnimatePresence>
  </motion.div>;
}
