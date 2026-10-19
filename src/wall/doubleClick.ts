import { doubleClick, type DoubleClickSettings } from "../ipc";

/** 读不到系统设置时的双击间隔与判定矩形（Windows 默认值）。 */
export const DEFAULT_DOUBLE_CLICK: DoubleClickSettings = { intervalMs: 500, width: 4, height: 4 };

let current = DEFAULT_DOUBLE_CLICK;
let loading: Promise<void> | null = null;

/** 现在使用的双击设置；系统设置读到之前是默认值。 */
export const doubleClickSettings = () => current;

/** 读一次系统的双击设置（#179），之后沿用；读不到时保留默认值。 */
export function loadDoubleClickSettings(): Promise<void> {
  loading ??= doubleClick().then(
    (settings) => { current = settings ?? DEFAULT_DOUBLE_CLICK; },
    () => { current = DEFAULT_DOUBLE_CLICK; },
  );
  return loading;
}

/** 测试用：回到默认值，下次重新读取。 */
export function resetDoubleClickSettings() {
  current = DEFAULT_DOUBLE_CLICK;
  loading = null;
}

/** 一次按下：时刻（performance.now）与窗口内的 CSS 坐标。 */
export type Press = { at: number; x: number; y: number };

/**
 * 这一下是不是 `first` 的第二下：在系统双击间隔内，且落在以第一下为中心、系统规定大小的矩形里
 * （矩形按物理像素，所以 CSS 坐标乘设备像素比）。只看时间和距离，不看落在哪个元素上。
 */
export function isSecondPress(first: Press, press: Press, settings: DoubleClickSettings, dpr: number): boolean {
  return press.at - first.at <= settings.intervalMs
    && Math.abs(press.x - first.x) * dpr <= settings.width / 2
    && Math.abs(press.y - first.y) * dpr <= settings.height / 2;
}
