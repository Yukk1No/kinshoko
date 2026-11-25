/** 弹簧曲线，写成 CSS 的 linear()。damping 越小回弹越多：0.78 几乎不过冲，0.6 是一个小的“啵”。 */
export function spring(damping: number) {
  const decay = 5.3; // 到终点时余量 0.5%
  const wd = (decay / damping) * Math.sqrt(1 - damping * damping);
  const points = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32;
    return (1 - Math.exp(-decay * t) * (Math.cos(wd * t) + (decay / wd) * Math.sin(wd * t))).toFixed(4);
  });
  points[32] = "1";
  return `linear(${points.join(", ")})`;
}
export const SETTLE = spring(0.78);
export const SETTLE_MS = 280; // 行让开、合上、弹回
export const LAND = spring(0.7);
export const LAND_MS = 360; // 松手后落到新位置
export const FOLLOW_MS = 42; // 手里那一张跟手的迟滞（指数趋近的时间常数）
export const LEAN = 6; // 线两边最近的一行让开 6 px，往外每行是前一行的 0.7 倍、晚 24 ms 出发
export const FALLOFF = 0.7;
export const STAGGER_MS = 24;
export const INTO_MS = 320; // 在一行中段停这么久算“放进去”
export const START_PX = 4; // 按下后移动这么远才算开始拖
export const INDENT = 16; // 每深一层缩进
export const EDGE = 32; // 指针离滚动区上下边这么近时自动滚动
export const SCROLL_MAX = 14; // 自动滚动每帧最多滚这么多
