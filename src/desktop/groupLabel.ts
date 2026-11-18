import type { TFunction } from "i18next";
import type { GroupSummary } from "../bindings/GroupSummary";
import { formatMoment } from "../i18n/format";

/**
 * 参考组在列表与菜单里的叫法（#588）：名称；没有名称时写“未命名”和最近保存的时间。
 * `t` 取 `desktop` 命名空间。
 */
export function groupLabel(t: TFunction<"desktop">, group: Pick<GroupSummary, "name" | "updatedAt">): string {
  const name = group.name.trim();
  if (name) return name;
  return t("deskGroups.unnamed", { time: formatMoment(group.updatedAt, { todayAsTime: true }) });
}
