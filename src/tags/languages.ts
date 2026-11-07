import { i18n } from "../i18n/instance";

/** 有界面写法的名称语言；写法在 `tags:language`，各语言用自称（简体中文、English…）。 */
const NAMED = ["zh-CN", "zh-TW", "en", "ja"] as const;

/** 名称语言的界面写法，例如“迁移后最终显示 · 简体中文”。没有的语言直接写代码。 */
export const languageName = (lang: string) =>
  (NAMED as readonly string[]).includes(lang) ? i18n.t(`tags:language.${lang as (typeof NAMED)[number]}`) : lang;

/** 来源名称可选的语言（#217）：按文字判断错了时由画师改；`und` 是未注明语言。 */
export const sourceLanguages = (): [string, string][] =>
  [...NAMED, "ko", "und"].map((lang) => [lang, i18n.t(`tags:language.${lang as (typeof NAMED)[number] | "ko" | "und"}`)]);
