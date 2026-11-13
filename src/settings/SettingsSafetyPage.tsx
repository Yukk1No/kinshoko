
import { useTranslation } from "react-i18next";
import { Layers, MousePointerClick, ShieldCheck, } from "lucide-react";
import type { SafeModeScope } from "../bindings/SafeModeScope";
import type { ShellSettingsView } from "../bindings/ShellSettingsView";
import { type ShellSettingsIntent } from "../shell/useShellSettings";
import { Segmented } from "../ui/Segmented";
import { SettingsGroup, SettingsRow, StatusPill } from "../ui/SettingsList";
import { Switch } from "../ui/Switch";
import { SealLock } from "../ui/SealLock";
import { Keys } from "../ui/Keys";

// 设置 › 安全分页，原样从 SettingsPanel.tsx 移出。

/** 安全模式范围（#223）的三档，从宽到严；名称与人工分级界面的分级名一致。 */
const SAFE_MODE_SCOPES: SafeModeScope[] = ["sensitive", "questionable", "explicit"];

type Props = {
  view: ShellSettingsView;
  safe?: boolean;
  onSafeMode?: () => void;
  apply: (intent: ShellSettingsIntent) => Promise<boolean>;
};

export function SafetyPage({ view, safe, onSafeMode, apply }: Props) {
  const { t } = useTranslation("settings");
  return (
          <SettingsGroup label={t("safety.group")}>
            <SettingsRow icon={<SealLock size={10} />} title={t("safety.safeMode")} hint={t("safety.safeModeHint")}>
              <Keys accelerator="Ctrl+Shift+S" />
              {safe !== undefined && onSafeMode && <Switch label={t("safety.safeMode")} checked={safe} onCheckedChange={(on) => { if (on !== safe) onSafeMode(); }} />}
            </SettingsRow>
            <SettingsRow icon={<Layers size={16} />} title={t("safety.scope")} hint={t("safety.scopeHint")}>
              <Segmented<SafeModeScope> label={t("safety.scope")} value={view.safeModeScope ?? "questionable"}
                onChange={(scope) => void apply({ kind: "safeModeScope", scope })} options={SAFE_MODE_SCOPES.map((value) => ({ value, label: t(`safety.scopeOption.${value}`) }))} />
            </SettingsRow>
            <SettingsRow icon={<MousePointerClick size={16} />} title={t("safety.keepSelection")} hint={t("safety.keepSelectionHint")}>
              <Switch label={t("safety.keepSelection")} checked={view.keepSelectionOnSafeMode ?? false} onCheckedChange={(on) => void apply({ kind: "keepSelectionOnSafeMode", on })} />
            </SettingsRow>
            <SettingsRow icon={<ShieldCheck size={16} />} title={t("safety.groupsAndPins")} hint={t("safety.groupsAndPinsHint")}>
              <StatusPill tone={safe === false ? "plain" : "ok"}>{safe === false ? t("safety.off") : t("safety.on")}</StatusPill>
            </SettingsRow>
          </SettingsGroup>
  );
}
