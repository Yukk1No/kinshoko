/** 名称语言的界面写法，例如“迁移后最终显示 · 简体中文”。没有的语言直接写代码。 */
export const LANGUAGE_NAMES: Record<string, string> = { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語" };

export const languageName = (lang: string) => LANGUAGE_NAMES[lang] ?? lang;
