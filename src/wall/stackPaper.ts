// 一摞的纸张（#418）：封面下最多露三层，摆法按图集键固定生成，每次看都一样。
// 维护者 2026-11-07 定为「统一朝向」（对比原型在分支 prototype/418-stack-paper）：封面摆正；
// 下面几层与封面同宽、高度按各页比例，整摞朝一边歪，越往下歪得越多，约三分之一的摞里有一层反过来；
// 纸边按像素露出（静止约 3–7 像素），横图和长图露得一样多。
// 这些像素数值以原型的封面宽 140 为准；封面更宽时整摞按比例放大，更窄时不再变细（维护者 2026-11-08）。
// 格子四周的内缩不是固定值：按静止时最外扩的那个纸角算（stackInset）。

/** 原型里的封面宽（CSS 像素）：纸边的像素数值在这个宽度下成立。 */
export const REFERENCE_FACE = 140;
/** 封面下最多露出的层数。 */
export const STACK_DEPTH = 3;
/** 下面几层比封面最多高出的像素（原型里是纸边 10 减 3）。 */
const OVERHANG = 7;
/** 纸角之外再给纸的细边线和投影留的像素。 */
const SHADOW_ROOM = 2;

/** 一层纸的摆放：平移（像素）与绕中心的转角（度）。 */
export type Pose = { x: number; y: number; r: number };
/** 封面下的一层：左上角与封面对齐，宽高是 CSS 像素；`rest` 是静止时的样子，`hot` 是悬停拿起后的样子。 */
export type Sheet = { page: number; w: number; h: number; rest: Pose; hot: Pose };
type Size = { w: number; h: number };

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

const deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * 封面下的各层，从最下层排到紧贴封面的那层。`pages` 是各页的尺寸（第一页是封面），`face` 是封面在格子里的尺寸，
 * `px` 是一个 CSS 像素在 `face` 的单位里有多长（界面缩放 200% 时为 0.5）。
 */
export function stackPaper(key: string, pages: readonly Size[], face: Size, px = 1): Sheet[] {
  const seed = 1 + (hash(key) % 997);
  const depth = Math.min(pages.length - 1, STACK_DEPTH);
  const unit = Math.max(px, face.w / REFERENCE_FACE);
  const dir = rnd(seed * 7) < 0.5 ? -1 : 1;
  const flipAt = depth >= 2 && rnd(seed * 11) < 0.35 ? 1 + Math.floor(rnd(seed * 19) * depth) : 0;
  const lean = 0.8 + 0.2 * rnd(seed * 23);
  const sheets: Sheet[] = [];
  for (let k = depth; k >= 1; k--) {
    const page = pages[k];
    const w = face.w;
    const h = Math.max(face.h * 0.84, Math.min(Math.round(w * (page.h / page.w)), face.h + OVERHANG * unit));
    const half = Math.hypot(w, h) / 2;
    const flipped = k === flipAt;
    const sign = flipped ? -dir : dir;
    const amount = flipped ? 0.6 + 0.3 * rnd(seed * 31 + k) : lean + 0.1 * rnd(seed * 31 + k);
    const restEdge = (2.4 + 1.4 * k) * amount * unit;
    const hotEdge = (5 + 3 * k) * amount * unit;
    sheets.push({
      page: k,
      w,
      h,
      rest: { x: sign * 0.4 * k * unit, y: 0.5 * k * unit, r: sign * deg(restEdge / half) },
      hot: { x: sign * (1 + 1.2 * k) * unit, y: (-1 - 0.8 * k) * unit, r: sign * deg(hotEdge / half) },
    });
  }
  return sheets;
}

/** 静止时最外扩的那个纸角伸出封面多远（四边里取最远的）。 */
function restReach(sheets: Sheet[], face: Size) {
  let reach = 0;
  for (const s of sheets) {
    const cx = s.w / 2 + s.rest.x,
      cy = s.h / 2 + s.rest.y;
    const a = (s.rest.r * Math.PI) / 180,
      cos = Math.cos(a),
      sin = Math.sin(a);
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const x = cx + ((dx * s.w) / 2) * cos - ((dy * s.h) / 2) * sin;
      const y = cy + ((dx * s.w) / 2) * sin + ((dy * s.h) / 2) * cos;
      reach = Math.max(reach, -x, -y, x - face.w, y - face.h);
    }
  }
  return reach;
}

/**
 * 一摞的格子四周留出的内缩：静止时最外扩的那个纸角加上阴影的余量，纸因此不出格子。
 * `boxWidth` 是格子宽（列宽），封面高按封面比例（不超过 `capRatio`）算，与瀑布流的算法一致。
 * 纸边随封面宽度变化，封面宽又取决于内缩，所以迭代到收敛，取最后两次里较大的那个（偏安全）。
 */
export function stackInset(
  key: string,
  pages: readonly Size[],
  boxWidth: number,
  capRatio: number | null,
  px = 1,
): number {
  const ratio = Math.min(pages[0].h / pages[0].w, capRatio ?? Infinity);
  const need = (inset: number) => {
    const w = Math.max(1, boxWidth - inset * 2);
    const face = { w, h: Math.max(w * ratio, 24) };
    return restReach(stackPaper(key, pages, face, px), face) + SHADOW_ROOM * px;
  };
  let inset = need(0);
  for (let i = 0; i < 8; i++) {
    const next = need(inset);
    if (Math.abs(next - inset) < 0.001) return Math.max(inset, next);
    inset = next;
  }
  return inset;
}
