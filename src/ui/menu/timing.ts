import type { CSSProperties } from "react";

/**
 * 菜单的全部时间常量（毫秒）。子菜单的延时与安全区由 cascade.ts 读，动效由样式表经 CSS 变量读
 * （`menuMotionVars` 挂在每一层浮层上）。
 */
export const MENU_TIMING = {
  /** 悬停一行多久之后才生效：文件夹行打开子菜单，普通行收起更深的子菜单。 */
  openDelay: 220,
  /** 拖着东西悬停在文件夹行上时，打开子菜单要等更久。 */
  dragOpenDelay: 420,
  /** 安全区里悬停的行每隔多久重查一次指针是否已离开安全区。 */
  safeRecheck: 80,
  /** 指针停在安全区里多久之后，悬停的行仍然换上自己的子菜单。 */
  safeWindowMax: 1200,
  /** 指针离开触发按钮、所有层与安全区多久之后整个菜单关闭（只对按钮打开的菜单）。 */
  closeDelay: 360,
  /** 浮层出现时透明度的过渡。 */
  fade: 170,
  /** 浮层出现时位移与缩放的过渡（带回弹）。 */
  spring: 360,
  /** 文件夹图标开合的过渡。 */
  folderMorph: 460,
  /** 切换浅色与深色时颜色、描边与阴影的交叉淡入。 */
  themeFade: 500,
} as const;

export const MENU_EASING = {
  /** 轻微回弹是手感的一部分，不要换成无回弹的曲线。 */
  spring: "cubic-bezier(0.2, 1.45, 0.35, 1)",
  folder: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

/** 挂在浮层上的动效变量，ui.css 的菜单规则只读这些变量，不写死时长。 */
export const menuMotionVars = {
  "--menu-fade": `${MENU_TIMING.fade}ms`,
  "--menu-spring": `${MENU_TIMING.spring}ms`,
  "--menu-spring-ease": MENU_EASING.spring,
  "--menu-folder": `${MENU_TIMING.folderMorph}ms`,
  "--menu-folder-ease": MENU_EASING.folder,
  "--menu-theme-fade": `${MENU_TIMING.themeFade}ms`,
} as CSSProperties;
