// 估算英文界面里哪些程序自己的文字放不下它的容器（#481）。不排版、不开窗口：按字符数估宽度，只给出要人看的名单。
// 用法：node --experimental-strip-types scripts/estimate-en-width.mjs
// 宽度 ≈ 字符数 × 字号 × 0.56（Inter 的平均字宽）；大写字母按 0.68 算。带 {{变量}} 的串按占位符 6 个字符估。
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DIR = "src/i18n/locales/en";
const CONTAINERS = [
  // 键名路径匹配 → 容器可用宽度 (px)、字号。超出就会换行或撑宽容器，要看这一条是不是该改短。
  { name: "设置左侧页签（200 − 内边距 24 − 图标与间距 24 = 152）", test: /^settings\.tab\./, width: 152, size: 14 },
  { name: "菜单项（260 − 内边距 12 − 图标 18 − 间距与右边距 24 = 206）", test: /(^|\.)(menu|context|ctx|pin)Menu?\.|\.menu\./i, width: 206, size: 14 },
  { name: "按钮（不换行，超过 160 会撑宽对话框底栏）", test: /\.(save|cancel|confirm|start|choose|change|import|export|restore|retry|rename|delete|remove|open|submit|done|next|previous|back|read|replace|keepEditing|discardConfirm|reconnect|saveInto|importConfirm|export|choose|importAnyway|importPackage|savePins|manual)$/, width: 160, size: 14 },
];

function flatten(value, path, out) {
  if (typeof value === "string") out.push([path, value]);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
}
const width = (text, size) => {
  const plain = text.replace(/\{\{[^}]*\}\}/g, "XXXXXX");
  let units = 0;
  for (const ch of plain) units += /[A-Z0-9]/.test(ch) ? 0.68 : /[ilj.,:;'!|]/.test(ch) ? 0.3 : 0.56;
  return units * size;
};

const rows = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
  // 错误文案（errors.ts）用无扩展名的相对导入，node 直接加载不了；它们不在按钮、菜单、页签里，跳过。
  const mod = await import(pathToFileURL(join(DIR, file)).href).then((m) => m.default, () => null);
  if (!mod) continue;
  const flat = [];
  flatten(mod, file.replace(/\.ts$/, ""), flat);
  for (const [path, text] of flat) {
    for (const c of CONTAINERS) {
      if (c.test.test(path) && width(text, c.size) > c.width) rows.push([c.name, path, text, Math.round(width(text, c.size))]);
    }
  }
}
for (const name of new Set(rows.map((r) => r[0]))) {
  console.log(`\n## ${name}`);
  for (const [, path, text, w] of rows.filter((r) => r[0] === name)) console.log(`- ${path}  ≈${w}px  "${text}"`);
}
if (rows.length === 0) console.log("没有估算会放不下的文案");
