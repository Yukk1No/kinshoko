import type { CatalogTag } from "../bindings/CatalogTag";
import { i18n } from "../i18n/instance";

/** 统一标签在某种语言的显示名：该语言的名称，没有时用其他语言的，都没有时用外部对应原名。 */
export const currentName = (tag: CatalogTag, lang: string) => tag.names.find((name) => name.lang === lang)?.name ?? tag.names[0]?.name
  ?? tag.external[0]?.name.replaceAll("_", " ") ?? i18n.t("tags:unnamed");
