import type { ReactNode } from "react";
import { Activity, Archive, Keyboard, RefreshCw, Rss, Settings2, ShieldCheck, Sparkles, Tags } from "lucide-react";
import { i18n } from "../i18n/instance";

export type SettingsTab = "general" | "keys" | "tags" | "tagging" | "backup" | "safety" | "subscriptions" | "update" | "diag";
const TABS: { value: SettingsTab; icon: ReactNode }[] = [
  { value: "general", icon: <Settings2 size={15} aria-hidden="true" /> },
  { value: "keys", icon: <Keyboard size={15} aria-hidden="true" /> },
  { value: "tags", icon: <Tags size={15} aria-hidden="true" /> },
  { value: "tagging", icon: <Sparkles size={15} aria-hidden="true" /> },
  { value: "backup", icon: <Archive size={15} aria-hidden="true" /> },
  { value: "safety", icon: <ShieldCheck size={15} aria-hidden="true" /> },
  { value: "update", icon: <RefreshCw size={15} aria-hidden="true" /> },
  { value: "diag", icon: <Activity size={15} aria-hidden="true" /> },
];

/** 订阅分页（#368）排在安全之后；这一版没有订阅功能时不出现。 */
export function tabsWith(subscriptions: boolean) {
  if (!subscriptions) return TABS;
  const at = TABS.findIndex((entry) => entry.value === "safety") + 1;
  return [...TABS.slice(0, at), { value: "subscriptions" as const, icon: <Rss size={15} aria-hidden="true" /> }, ...TABS.slice(at)];
}
/** 分页名；订阅分页的名字在订阅的文案模块里。 */
export function tabName(value: SettingsTab): string {
  return value === "subscriptions" ? i18n.t("subscriptions:settings.tab") : i18n.t(`settings:tab.${value}`);
}
