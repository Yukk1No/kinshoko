import { useTranslation } from "react-i18next";
import { interfaceLanguage, onInterfaceLanguage } from "../ipc";
import { i18n, SOURCE_LANG, supported, type UiLang } from "./instance";

export { SOURCE_LANG, UI_LANGS, type UiLang } from "./instance";

const syncDocumentLang = (lang: string) => {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
};
// 首帧的语言也写进文档（index.html 写的是 zh-CN），读屏软件按它朗读。
syncDocumentLang(i18n.language);
i18n.on("languageChanged", syncDocumentLang);

/** 改为 `lang`；不是有翻译的界面语言时不变。 */
export function applyInterfaceLanguage(lang: string): void {
  if (supported(lang) && i18n.language !== lang) void i18n.changeLanguage(lang);
}

/**
 * 让这个页面跟着核心的界面语言（#354）：先取当前值，之后随 `interface-language` 事件切换，不需重启。
 * 主窗口、截图窗口与钉图菜单窗口共用这个页面，各自启动时调用一次。
 */
export function followInterfaceLanguage(): () => void {
  let alive = true;
  const unlisten = onInterfaceLanguage(applyInterfaceLanguage);
  interfaceLanguage().then((lang) => alive && applyInterfaceLanguage(lang), () => {});
  return () => {
    alive = false;
    void unlisten.then((f) => f()).catch(() => {});
  };
}

/** 当前界面语言；切换时重新渲染。按语言取数据（标签显示名称等）的组件把它放进依赖。 */
export function useUiLang(): UiLang {
  const { i18n: instance } = useTranslation();
  return supported(instance.language) ? instance.language : SOURCE_LANG;
}

export { i18n };
