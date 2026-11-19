/**
 * 脚本里过渡的唯一来源（design/ui-system/scales.md「动效」）。样式里的时长与曲线在 src/styles/tokens.css；
 * 用 motion 写的过渡从这里取，不另写数值。减弱动效下由调用方换成 `{ duration: 0 }`（src/ui/reducedMotion.ts）。
 */
export { spring } from "./vendor/fluid/springs";

/** Arc Library 的三档弹簧：按钮与 dock 的形变、浮岛、悬浮栏、查看器飞入。 */
export const arcSpring = {
  snappy: { type: "spring" as const, visualDuration: 0.26, bounce: 0.12 },
  morph: { type: "spring" as const, visualDuration: 0.42, bounce: 0.16 },
  smooth: { type: "spring" as const, visualDuration: 0.4, bounce: 0 },
};
