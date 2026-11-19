import type { GroupSummary } from "../bindings/GroupSummary";
import { formatMoment } from "../i18n/format";

/**
 * 参考组在列表与菜单里的叫法（#588）：名称；没有名称时写新建的日期和时间（默认名称待维护者定）。
 */
export function groupLabel(group: Pick<GroupSummary, "name" | "createdAt">): string {
  return group.name.trim() || formatMoment(group.createdAt);
}

/** 本地日期 `YYYY-MM-DD`：成员按添加日期分段（#588“按天分段”），也是“移到新参考组”的参数。 */
export function localDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
