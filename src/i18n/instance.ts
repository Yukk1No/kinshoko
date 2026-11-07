// i18next 的实例与初始化（#354）。不依赖 IPC，命令错误的文案（`src/ipc/commandError.ts`）也从这里取。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
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

export const supported = (lang: unknown): lang is UiLang => (UI_LANGS as readonly unknown[]).includes(lang);

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

export { i18n };
