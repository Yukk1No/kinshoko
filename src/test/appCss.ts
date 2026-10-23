import index from "../styles.css?raw";

const parts = import.meta.glob<string>("../styles/*.css", { query: "?raw", import: "default", eager: true });

/** 全局样式表（src/styles.css）按 `@import` 的顺序拼起来的全文，供按样式表锁住声明与先后次序的测试使用。 */
export const appCss = [...index.matchAll(/@import "\.\/(styles\/[^"]+)";/g)]
  .map(([, path]) => {
    const part = parts[`../${path}`];
    if (part === undefined) throw new Error(`styles.css 导入了不存在的 ${path}`);
    return part;
  })
  .join("");
