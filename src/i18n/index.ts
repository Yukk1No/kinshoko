import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { interfaceLanguage, onInterfaceLanguage } from "../ipc";
import { resources } from "./resources";

/** 有翻译的界面语言，与核心的 `interface_lang::SUPPORTED` 相同。 */
export const UI_LANGS = ["zh-CN", "en"] as const;
export type UiLang = (typeof UI_LANGS)[number];
export const SOURCE_LANG: UiLang = "zh-CN";

declare global {
  interface Window {
    /** 核心建主窗口时写入的界面语言，首帧就用它（#354）。 */
    __KINSHOKO_INTERFACE_LANG__?: string;
  }
}

const supported = (lang: unknown): lang is UiLang => (UI_LANGS as readonly unknown[]).includes(lang);

/** 页面启动时的界面语言：核心预先写入的值；没有时为简体中文。之后以 `interface_language` 命令为准。 */
function initialLang(): UiLang {
  const seeded = typeof window === "undefined" ? undefined : window.__KINSHOKO_INTERFACE_LANG__;
  return supported(seeded) ? seeded : SOURCE_LANG;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLang(),
  fallbackLng: SOURCE_LANG,
  supportedLngs: [...UI_LANGS],
  defaultNS: "update",
  initAsync: false,
  // React 自己转义。
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lang) => {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
});

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
