import { expect } from "vitest";

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

/**
 * 英文界面下这块界面里没有中文（#356）：可见文字与读屏用的名称（aria-label、title、alt、placeholder）都查。
 * `allowed` 是画师自己的数据（图库名、标签名等），出现中文不算。
 */
export function expectNoChinese(root: ParentNode, allowed: string[] = []) {
  const strip = (text: string) => allowed.reduce((rest, data) => rest.split(data).join(""), text);
  const found: string[] = [];
  const text = strip((root as Element).textContent ?? "");
  if (CJK.test(text)) found.push(`text: ${text}`);
  for (const el of root.querySelectorAll("[aria-label], [title], [alt], [placeholder]")) {
    for (const name of ["aria-label", "title", "alt", "placeholder"]) {
      const value = el.getAttribute(name);
      if (value && CJK.test(strip(value))) found.push(`${name}: ${value}`);
    }
  }
  expect(found).toEqual([]);
}
