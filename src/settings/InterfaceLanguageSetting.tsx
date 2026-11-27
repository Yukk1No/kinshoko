import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { errorText, interfaceLanguageChoice, setInterfaceLanguage, type InterfaceLanguageChoice } from "../ipc";
import { applyInterfaceLanguage } from "../i18n";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { SettingsRow } from "../ui/SettingsList";
import { Select } from "../ui/Select";

const CHOICES: InterfaceLanguageChoice[] = ["system", "zh-CN", "en"];
const INTERFACE_LANGUAGE_CHOICE_KEY = "interface-language-choice";

/** 界面语言偏好的后端镜像（#778）：读取共享；写入成功后由写入方交回最新选择。 */
const interfaceLanguageChoiceMirror = createBackendMirror<
  typeof INTERFACE_LANGUAGE_CHOICE_KEY,
  InterfaceLanguageChoice
>({
  read: () => interfaceLanguageChoice(),
});

function useInterfaceLanguageChoice() {
  return useBackendMirror(interfaceLanguageChoiceMirror, INTERFACE_LANGUAGE_CHOICE_KEY);
}

/**
 * 设置 › 通用 的「界面语言」（#358）：跟随系统（默认）、简体中文、English。改了立即换，不需重启；
 * 选择由核心保存，下次启动照旧。读不到选择时不显示这一行。
 */
export function InterfaceLanguageSetting({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation("settings");
  const saved = useInterfaceLanguageChoice().value;
  const [draft, setDraft] = useState<InterfaceLanguageChoice | null>(null);

  if (saved === null) return null;
  const choice = draft ?? saved;
  const change = (next: InterfaceLanguageChoice) => {
    setDraft(next);
    setInterfaceLanguage(next).then(
      (lang) => {
        interfaceLanguageChoiceMirror.accept(INTERFACE_LANGUAGE_CHOICE_KEY, next);
        setDraft((current) => (current === next ? null : current));
        applyInterfaceLanguage(lang);
      },
      (e) => {
        setDraft((current) => (current === next ? null : current));
        onError(errorText(e));
      },
    );
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
