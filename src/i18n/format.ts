// 日期与数字按界面语言格式化（#356）：不写死 "zh-CN"，切换界面语言后随之变化。
import { i18n } from "./instance";

/** 日期与时间，例如收集时间。 */
export function formatDateTime(at: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(at).toLocaleString(i18n.language, options);
}

/** 带千分位的整数或小数。 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(i18n.language, options);
}

/** 比例夹在 0–1 内；非数（总数为 0 等）算 0。 */
export function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
}

/**
 * `part / total` 的整数百分点（0–100）。向下取整，让 100 只在真正完成时出现；
 * `total` 为 0 或数值非法时为 0。进度条的宽度与文字都用它，不会超过 100。
 */
export function percentOf(part: number, total: number): number {
  return Math.floor(clampRatio(total > 0 ? part / total : 0) * 100 + 1e-6);
}

/** 0–1 的比例显示为整数百分比，例如 0.87 → “87%”；规则同 `percentOf`。 */
export function formatPercent(ratio: number): string {
  return formatNumber(percentOf(clampRatio(ratio), 1) / 100, { style: "percent", maximumFractionDigits: 0 });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 小于 100 保留 1 位小数，其余取整。 */
const roundSize = (value: number) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);

/**
 * 字节数显示为人读的大小，例如 “993 MB”“7.9 GB”。
 * 进位用 1024（和 Windows 资源管理器一致），单位写 B / KB / MB / GB / TB，不随界面语言变；数字随语言。
 * 位数：不足 1 KB 显示整数字节；其余数值小于 100 时最多 1 位小数（整数时不带 “.0”），≥ 100 取整。
 * 四舍五入后凑满 1024 时进到下一档，免得出现 “1,024 KB”。
 */
export function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && (value >= 1024 || (unit > 0 && roundSize(value) >= 1024))) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(unit === 0 ? Math.round(value) : roundSize(value))} ${BYTE_UNITS[unit]}`;
}

type MomentOptions = {
  /** 比较“今天”和“今年”用的当前时间，测试里指定。 */
  now?: number;
  /** 按记录时的时区偏移（分钟，东为正）显示，而不是本机时区。 */
  offsetMinutes?: number;
  /** 当天的时刻只显示时间（不带日期）。 */
  todayAsTime?: boolean;
  /** 为 false 时只要日期。 */
  time?: boolean;
};

/** 日历日，用来比较是不是同一天、同一年。 */
function calendar(ms: number, utc: boolean) {
  const d = new Date(ms);
  return utc ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() } : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

/**
 * 日期（和时间）的统一写法：不显示秒；月份用短写（中文 “3月5日”，英文 “Mar 5”）；
 * 只有不在今年时才带年份。`todayAsTime` 时当天只显示时间。
 */
export function formatMoment(at: number, options: MomentOptions = {}): string {
  const { now = Date.now(), offsetMinutes, todayAsTime = false, time = true } = options;
  const utc = offsetMinutes !== undefined;
  const shift = (offsetMinutes ?? 0) * 60_000;
  const when = calendar(at + shift, utc);
  const today = calendar(now + shift, utc);
  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const zone: Intl.DateTimeFormatOptions = utc ? { timeZone: "UTC" } : {};
  const sameDay = when.y === today.y && when.m === today.m && when.d === today.d;
  if (time && todayAsTime && sameDay) return formatDateTime(at + shift, { ...timeFormat, ...zone });
  const date: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(when.y === today.y ? {} : { year: "numeric" }) };
  return formatDateTime(at + shift, { ...date, ...(time ? timeFormat : {}), ...zone });
}
