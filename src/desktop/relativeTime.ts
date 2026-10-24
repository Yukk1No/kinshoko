/** 侧栏卡片上的时间：刚刚 / N 分钟前 / 今天 N 小时前 / 昨天 / M 月 D 日（跨年带年份）。 */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const then = new Date(at);
  const today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(today) - day(then)) / 86_400_000);
  if (days === 0) return `${Math.floor(minutes / 60)} 小时前`;
  if (days === 1) return "昨天";
  const date = `${then.getMonth() + 1} 月 ${then.getDate()} 日`;
  return then.getFullYear() === today.getFullYear() ? date : `${then.getFullYear()} 年 ${date}`;
}
