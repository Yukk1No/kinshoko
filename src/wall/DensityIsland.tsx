import { Image } from "lucide-react";
import { DensitySlider } from "./DensitySlider";

/**
 * 图片大小 (#102 故事15/16, 方案 C3): the size slider floats at the bottom-right of the image wall,
 * between a small and a large picture mark, so it reads as the pair of Ctrl+wheel zoom.
 * Commit behaviour is DensitySlider's: drags commit on release, keyboard steps 220 ms after the last one.
 * `preview` is the wall's Ctrl+wheel zoom (#111) in progress: the slider shows it; the wall commits it.
 */
export function DensityIsland(p: { value: number; preview?: number | null; onPreview: (v: number | null) => void; onCommit: (v: number) => void }) {
  return <div className="k-density-island density" role="group" aria-label="图片大小">
    <Image size={12} strokeWidth={1.75} data-end="small" aria-hidden="true" />
    <DensitySlider label="图片大小" value={p.value} preview={p.preview} onPreview={p.onPreview} onCommit={p.onCommit} />
    <Image size={16} strokeWidth={1.75} data-end="large" aria-hidden="true" />
  </div>;
}
