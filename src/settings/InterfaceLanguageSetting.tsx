import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { errorText, interfaceLanguageChoice, setInterfaceLanguage, type InterfaceLanguageChoice } from "../ipc";
import { applyInterfaceLanguage } from "../i18n";
import { SettingsRow } from "../ui/SettingsList";
import { Select } from "../ui/Select";

const CHOICES: InterfaceLanguageChoice[] = ["system", "zh-CN", "en"];

/**
 * 设置 › 通用 的「界面语言」（#358）：跟随系统（默认）、简体中文、English。改了立即换，不需重启；
 * 选择由核心保存，下次启动照旧。读不到选择时不显示这一行。
 */
export function InterfaceLanguageSetting({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const [choice, setChoice] = useState<InterfaceLanguageChoice | null>(null);

  useEffect(() => {
    let alive = true;
    interfaceLanguageChoice().then(
      (saved) => alive && setChoice(saved),
      // 忽略失败：读不到时不显示这一项，其余设置照常可用。
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  if (choice === null) return null;
  const change = (next: InterfaceLanguageChoice) => {
    const previous = choice;
    setChoice(next);
    setInterfaceLanguage(next).then(applyInterfaceLanguage, (e) => {
      setChoice(previous);
      onError(errorText(e));
    });
  };
  return (
    <SettingsRow icon={<Languages size={16} />} title={t("general.language")} hint={t("general.languageHint")}>
      <Select
        label={t("general.language")}
        value={choice}
        onChange={change}
        options={CHOICES.map((value) => ({ value, label: t(`general.languages.${value}`) }))}
      />
    </SettingsRow>
  );
}
