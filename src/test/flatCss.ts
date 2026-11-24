/** 去掉注释、把空白压成一个空格：规则写成几行都按同一个写法比较（格式化不改变这里的结果）。 */
export const flatCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

/** 压平后的样式表里不带嵌套的规则，一条一项。 */
export const flatRules = (css: string) => (flatCss(css).match(/[^{}]+\{[^{}]*\}/g) ?? []).map((rule) => rule.trim());
