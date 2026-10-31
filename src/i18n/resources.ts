import type { Translation } from "./translation";
import update from "./locales/zh-CN/update";
import errors from "./locales/zh-CN/errors";
import pins from "./locales/zh-CN/pins";
import common from "./locales/zh-CN/common";
import shell from "./locales/zh-CN/shell";
import wall from "./locales/zh-CN/wall";
import viewer from "./locales/zh-CN/viewer";
import enUpdate from "./locales/en/update";
import enErrors from "./locales/en/errors";
import enPins from "./locales/en/pins";
import enCommon from "./locales/en/common";
import enShell from "./locales/en/shell";
import enWall from "./locales/en/wall";
import enViewer from "./locales/en/viewer";

/**
 * 界面文案（#353）：按功能模块分文件，`zh-CN` 为源语言，`en` 为翻译。新增模块时两边各加一份，
 * 再登记到这里；译文少了模块或键，`tsc` 报错。
 */
export const zhCN = { update, errors, pins, common, shell, wall, viewer };

export const resources = {
  "zh-CN": zhCN,
  en: {
    update: enUpdate, errors: enErrors, pins: enPins, common: enCommon, shell: enShell, wall: enWall, viewer: enViewer,
  } satisfies { [M in keyof typeof zhCN]: Translation<(typeof zhCN)[M]> },
};
