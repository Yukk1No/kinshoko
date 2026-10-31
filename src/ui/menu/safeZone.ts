/**
 * 子菜单安全区的几何（纯函数）。子菜单打开时，从指针的上一个位置到子菜单近边的两个角（子菜单在右侧时为左边的
 * 上下两角）连一个三角形；指针在三角形里、且在父层朝子菜单一侧的最后一段宽度内，就当作正在去子菜单的路上，
 * 途经的行不高亮、不打开自己的子菜单。
 */
export type Point = { x: number; y: number };
export type Box = { left: number; top: number; right: number; bottom: number };
export type Side = "left" | "right";

/** (b − a) × (p − a)：p 在有向边 a→b 的哪一侧。 */
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

/** 三条边的叉积同号（或为零）时点在三角形内，边上也算。 */
export function pointInTriangle(p: Point, a: Point, b: Point, c: Point) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** 父层朝子菜单一侧的那段宽度：min(90, max(56, 父层宽度的 43%))。 */
export const approachBand = (parentWidth: number) => Math.min(90, Math.max(56, parentWidth * 0.43));

/** 子菜单在父层的哪一侧（看两者中线）。 */
export const submenuSide = (parent: Box, submenu: Box): Side =>
  submenu.left + submenu.right >= parent.left + parent.right ? "right" : "left";

/** 安全三角形：顶点是指针的上一个位置，另两点是子菜单近边的上下两角。 */
export function safeTriangle(apex: Point, submenu: Box, side: Side): [Point, Point, Point] {
  const x = side === "right" ? submenu.left : submenu.right;
  return [apex, { x, y: submenu.top }, { x, y: submenu.bottom }];
}

/** 父层里朝子菜单一侧的那一段（安全区只在这段里生效）。 */
export function approachStrip(parent: Box, side: Side): Box {
  const band = approachBand(parent.right - parent.left);
  return side === "right" ? { ...parent, left: parent.right - band } : { ...parent, right: parent.left + band };
}

/** 指针是否正在去子菜单的路上。apex 取倒数第二次 pointermove 的位置，三角形不会缩到当前点上。 */
export function headingToSubmenu({ apex, point, parent, submenu, side = submenuSide(parent, submenu) }: {
  apex: Point; point: Point; parent: Box; submenu: Box; side?: Side;
}) {
  const strip = approachStrip(parent, side);
  if (point.x < strip.left || point.x > strip.right) return false;
  return pointInTriangle(point, ...safeTriangle(apex, submenu, side));
}
