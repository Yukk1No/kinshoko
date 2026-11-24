import main from "../main.tsx?raw";

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

/** 一份样式表的原文，`@import` 的样式表按次序展开在它的位置。 */
function expand(path: string): string {
  const css = sheets[path];
  if (css === undefined) throw new Error(`导入了不存在的样式表 ${path}`);
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return css.replace(/@import "\.\/([^"]+)";/g, (_, rel: string) => expand(dir + rel));
}

/** 主窗口页面的全部样式表（src/main.tsx 按次序导入的那些）拼起来的全文，次序就是层叠次序。
 *  供按样式表锁住声明与先后次序的测试使用。 */
export const appCss = [...main.matchAll(/^import "\.\/([^"]+\.css)";/gm)]
  .map(([, path]) => expand(`../${path}`))
  .join("\n");
