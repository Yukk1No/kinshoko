/** 名称语言的界面写法，例如“简体中文显示名”“迁移后最终显示 · 简体中文”。没有的语言直接写代码。 */
export const LANGUAGE_NAMES: Record<string, string> = { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語" };

export const languageName = (lang: string) => LANGUAGE_NAMES[lang] ?? lang;

/** 来源名称可选的语言（#217）：按文字判断错了时由画师改；`und` 是未注明语言。 */
export const SOURCE_LANGUAGES: [string, string][] = [...Object.entries(LANGUAGE_NAMES), ["ko", "한국어"], ["und", "未注明语言"]];
