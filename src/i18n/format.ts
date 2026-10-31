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
