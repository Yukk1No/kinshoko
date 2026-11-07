// 一摞的纸张（#418）：封面下最多露三层，摆法按图集键固定生成，每次看都一样。
// 维护者 2026-11-07 定为「统一朝向」（对比原型在分支 prototype/418-stack-paper）：封面摆正；
// 下面几层与封面同宽、高度按各页比例，整摞朝一边歪，越往下歪得越多，约三分之一的摞里有一层反过来；
// 纸边按像素露出（静止约 3–7 像素），横图和长图露得一样多。

/** 封面四周留出的纸边（CSS 像素）：静止时纸角不出格子。 */
export const STACK_INSET = 10;
/** 封面下最多露出的层数。 */
export const STACK_DEPTH = 3;

/** 一层纸的摆放：平移（像素）与绕中心的转角（度）。 */
export type Pose = { x: number; y: number; r: number };
/** 封面下的一层：左上角与封面对齐，宽高是 CSS 像素；`rest` 是静止时的样子，`hot` 是悬停拿起后的样子。 */
export type Sheet = { page: number; w: number; h: number; rest: Pose; hot: Pose };

/** 图集键的 32 位散列（FNV-1a）。 */
function hash(key: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** 0 到 1 之间的确定性随机数。 */
function rnd(n: number) {
  let t = (n * 2654435761) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const deg = (rad: number) => rad * 180 / Math.PI;

/**
 * 封面下的各层，从最下层排到紧贴封面的那层。`pages` 是各页的尺寸（第一页是封面），`face` 是封面在格子里的尺寸。
 * 每层超出封面的高度最多 2 像素，转过之后纸角仍在格子里。
 */
export function stackPaper(key: string, pages: readonly { w: number; h: number }[], face: { w: number; h: number }): Sheet[] {
  const seed = 1 + (hash(key) % 997);
  const depth = Math.min(pages.length - 1, STACK_DEPTH);
  const dir = rnd(seed * 7) < 0.5 ? -1 : 1;
  const flipAt = depth >= 2 && rnd(seed * 11) < 0.35 ? 1 + Math.floor(rnd(seed * 19) * depth) : 0;
  const lean = 0.8 + 0.2 * rnd(seed * 23);
  const sheets: Sheet[] = [];
  for (let k = depth; k >= 1; k--) {
    const page = pages[k];
    const w = face.w;
    const h = Math.max(face.h * 0.84, Math.min(Math.round(w * (page.h / page.w)), face.h + 2));
    const half = Math.hypot(w, h) / 2;
    const flipped = k === flipAt;
    const sign = flipped ? -dir : dir;
    const amount = flipped ? 0.6 + 0.3 * rnd(seed * 31 + k) : lean + 0.1 * rnd(seed * 31 + k);
    const restEdge = (2.4 + 1.4 * k) * amount;
    const hotEdge = (5 + 3 * k) * amount;
    sheets.push({
      page: k, w, h,
      rest: { x: sign * 0.4 * k, y: 0.5 * k, r: sign * deg(restEdge / half) },
      hot: { x: sign * (1 + 1.2 * k), y: -1 - 0.8 * k, r: sign * deg(hotEdge / half) },
    });
  }
  return sheets;
}
