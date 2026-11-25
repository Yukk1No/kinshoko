import { describe, expect, it } from "vitest";
import table from "./locales/terms.md?raw";
import { resources } from "./resources";

/** 对照表的行：中文词 → 英文的几种写法。 */
const terms = table
  .split("\n")
  .filter((line) => line.startsWith("| ") && !line.startsWith("| 中文") && !line.startsWith("| ---"))
  .map((line) => {
    const [zh, en] = line
      .split("|")
      .slice(1, 3)
      .map((cell) => cell.trim());
    return { zh, en: en.split(" / ").map((form) => form.toLowerCase()) };
  });

/** 放不下或另有原因、不按对照表写的文案：键 → 原因。 */
const EXCEPTIONS: Record<string, string> = {
  "desktop.groups.importConfirm": "选目标图库对话框的确认按钮，标题已写明导入参考组包",
};

type Tree = { [key: string]: string | Tree };
const flatten = (tree: Tree, prefix = "", out = new Map<string, string>()) => {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix + key;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, `${path}.`, out);
  }
  return out;
};
const zh = flatten(resources["zh-CN"] as unknown as Tree);
const en = flatten(resources.en as unknown as Tree);
/** 复数键（`_one`、`_other` 等）归到同一条文案。 */
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");

describe("界面用语对照表", () => {
  it("表里有词", () => {
    expect(terms.length).toBeGreaterThan(10);
  });

  it("中文里有表中的词，英文就用表里的说法", () => {
    const misses: string[] = [];
    for (const [key, text] of zh) {
      if (EXCEPTIONS[base(key)]) continue;
      const translations = [...en].filter(([k]) => base(k) === base(key)).map(([, v]) => v.toLowerCase());
      for (const term of terms) {
        // 去掉含这个词的更长的词，那些按自己那一行查。
        const rest = terms
          .filter((other) => other.zh !== term.zh && other.zh.includes(term.zh))
          .reduce((s, other) => s.replaceAll(other.zh, ""), text);
        if (!rest.includes(term.zh)) continue;
        if (!translations.some((t) => term.en.some((form) => t.includes(form))))
          misses.push(`${key}：“${text}” → “${translations.join(" | ")}” 没有 ${term.en.join(" / ")}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("例外里的键都还在", () => {
    expect(Object.keys(EXCEPTIONS).filter((key) => !zh.has(key))).toEqual([]);
  });
});
