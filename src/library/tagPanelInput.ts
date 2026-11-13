import type { ImageTag } from "../bindings/ImageTag";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagNamespace } from "../bindings/TagNamespace";
import { tagStanding, type TagStanding } from "../tags/tagConfidence";

export const NAMESPACES: TagNamespace[] = ["general", "artist", "character", "work"];

type Group = { kind: TagStanding["kind"]; tags: ImageTag[] };

/**
 * 按出处分组（#482）：你添加的 / 导入 / 打标模型（按可信度从高到低，没有分数的在后）；空组不列。
 * 不分组时也按这个次序排成一列：人写的在前，模型标签在后。
 */
export function groupByStanding(tags: ImageTag[]): Group[] {
  const groups: Group[] = [
    { kind: "manual", tags: [] },
    { kind: "imported", tags: [] },
    { kind: "model", tags: [] },
  ];
  const scoreOf = new Map<ImageTag, number>();
  for (const entry of tags) {
    const standing = tagStanding(entry.origins);
    if (standing.kind === "model") scoreOf.set(entry, standing.score ?? -1);
    groups[standing.kind === "manual" ? 0 : standing.kind === "imported" ? 1 : 2].tags.push(entry);
  }
  groups[2].tags.sort((a, b) => scoreOf.get(b)! - scoreOf.get(a)!);
  return groups.filter((group) => group.tags.length > 0);
}

/** 不分组时的次序：人写的在前，模型标签按可信度从高到低。 */
export const ordered = (tags: ImageTag[]) => groupByStanding(tags).flatMap((group) => group.tags);

/**
 * 输入框里的字：开头写了类别（“角色：初音”“作品:xx”，与标签的显示名同一写法）就按它新建，候选也只列这个类别。
 * 全角、半角冒号都认；不写类别时 `namespace` 为 null。
 */
// 半角或全角冒号结尾（全角写成转义，免得被当成写死的界面文字）。
const ENDS_WITH_COLON = new RegExp("[:" + String.fromCharCode(0xff1a) + "]$");

export function parseTyped(text: string, prefixOf: (namespace: TagNamespace) => string): { namespace: TagNamespace | null; name: string } {
  const trimmed = text.trim();
  for (const namespace of NAMESPACES) {
    const prefix = prefixOf(namespace).trim().replace(ENDS_WITH_COLON, "");
    if (!prefix) continue;
    const head = trimmed.slice(0, prefix.length + 1);
    if (head.length === prefix.length + 1 && ENDS_WITH_COLON.test(head) && head.slice(0, -1).toLocaleLowerCase() === prefix.toLocaleLowerCase())
      return { namespace, name: trimmed.slice(prefix.length + 1).trim() };
  }
  return { namespace: null, name: trimmed };
}

/**
 * 在候选行上按键或单击做什么：回车 / 单击添加；Alt+回车 / Ctrl+单击排除，与查找框的写法相同；
 * Shift+回车 / Shift+单击改回自动（行尾按钮不可聚焦，键盘靠它）。
 */
export const decisionOf = (event: { type: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): TagEdit["kind"] =>
  event.shiftKey ? "clear" : (event.type === "keydown" ? event.altKey : event.ctrlKey || event.metaKey) ? "reject" : "add";
