import { motion, useReducedMotion } from "motion/react";

/** logo 里 `i` 上的那颗星，原样取自 design/logo-kit/master/geometry.json 的 `wordmark.i_star`。 */
export const I_STAR = "M132 32 C136.16 53.84 136.16 53.84 158 58 C136.16 62.16 136.16 62.16 132 84 C127.84 62.16 127.84 62.16 106 58 C127.84 53.84 127.84 53.84 132 32 Z";

/**
 * 原始像素读数上的星（#103）：放在读数文字的末尾，由 CSS 挂到最后一个字的右上角，约为字号的 0.8（#130）。
 * 出现时以弹簧从 0 放大并轻转约 15° 落定；“减少动画”时直接出现。颜色日夜相同。
 */
export function OriginalStar() {
  const reduced = useReducedMotion();
  return <motion.svg className="k-original-star" viewBox="106 32 52 52" aria-hidden="true" focusable="false"
    initial={reduced ? false : { scale: 0, rotate: -15 }} animate={{ scale: 1, rotate: 0 }}
    transition={{ type: "spring", visualDuration: 0.42, bounce: 0.38 }}>
    <path d={I_STAR} />
  </motion.svg>;
}
