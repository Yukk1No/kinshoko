/** 复数后缀（i18next 按 `Intl.PluralRules`）。源语言中文只写 `_other`，译文可以另写其他形式。 */
type PluralForm = "zero" | "one" | "two" | "few" | "many";
type PluralKeys<K> = K extends `${infer Base}_other` ? `${Base}_${PluralForm}` : never;

/** 一份译文的形状：与源语言（`zh-CN`）的键一一对应，复数键可以多出别的形式。 */
export type Translation<T> = { [K in keyof T]: T[K] extends string ? string : Translation<T[K]> } & {
  [K in PluralKeys<keyof T & string>]?: string;
};
