import { i18n } from "../i18n/instance";

/** 侧栏卡片上的时间：刚刚 / N 分钟前 / 今天 N 小时前 / 昨天 / M 月 D 日（跨年带年份）。 */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return i18n.t("desktop:ago.justNow");
  if (minutes < 60) return i18n.t("desktop:ago.minutes", { count: minutes });
  const then = new Date(at);
  const today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(today) - day(then)) / 86_400_000);
  if (days === 0) return i18n.t("desktop:ago.hours", { count: Math.floor(minutes / 60) });
  if (days === 1) return i18n.t("desktop:ago.yesterday");
  const date = { month: then.getMonth() + 1, day: then.getDate() };
  return then.getFullYear() === today.getFullYear()
    ? i18n.t("desktop:ago.date", date)
    : i18n.t("desktop:ago.dateWithYear", { ...date, year: then.getFullYear() });
}
