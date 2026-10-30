import type { Translation } from "./translation";
import update from "./locales/zh-CN/update";
import enUpdate from "./locales/en/update";

/**
 * 界面文案（#353）：按功能模块分文件，`zh-CN` 为源语言，`en` 为翻译。新增模块时两边各加一份，
 * 再登记到这里；译文少了模块或键，`tsc` 报错。
 */
export const zhCN = { update };

export const resources = {
  "zh-CN": zhCN,
  en: { update: enUpdate } satisfies { [M in keyof typeof zhCN]: Translation<(typeof zhCN)[M]> },
};
