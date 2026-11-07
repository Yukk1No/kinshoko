import "i18next";
import type { zhCN } from "./resources";

// 翻译键按源语言检查：写错键 `tsc` 报错。
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "update";
    resources: typeof zhCN;
  }
}
