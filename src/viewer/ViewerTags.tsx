import { useEffect, useState } from "react";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagNamespace } from "../bindings/TagNamespace";
import { imageTags } from "../ipc";
import { TagMarks, UI_LANG } from "../search/SearchBox";
import { ConfidenceMeter, chipBand } from "../tags/TagChip";
import { originLine, tagStanding } from "../tags/tagConfidence";
import { useTagDisplay } from "../tags/TagDisplayContext";

/** 查看器里按命名空间分组的顺序（#147）。 */
const GROUPS: { value: TagNamespace; label: string }[] = [
  { value: "artist", label: "作者" },
  { value: "character", label: "角色" },
  { value: "work", label: "作品" },
  { value: "general", label: "一般" },
];

type Props = {
  libraryId: string;
  imageId: string;
  /** 资料库报告列表过期时递增：重新读取。 */
  reloadKey: number;
};

/**
 * 查看器信息面板里的标签（#147）：只读，与详情面板读同一份有效标签（`image_tags`），按命名空间分组；
 * 标签上只有名称；外观跟着当前标签风格（#160）：B 按可信度分档底色，C 带可信度刻度条，出处与精确数值在悬停提示里。
 * 编辑仍在主窗口的详情面板里做，这里没有控件。
 */
export function ViewerTags({ libraryId, imageId, reloadKey }: Props) {
  const [tags, setTags] = useState<ImageTags | null>(null);
  const [failed, setFailed] = useState(false);
  const display = useTagDisplay();

  useEffect(() => {
    let alive = true;
    setTags(null);
    setFailed(false);
    imageTags(libraryId, imageId, UI_LANG).then((value) => { if (alive) setTags(value); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [libraryId, imageId, reloadKey]);

  return (
    <section className="viewer-tags" aria-label="标签" data-low-outline={display.lowOutline ? "" : undefined}>
      <h4>标签</h4>
      {failed && <p className="viewer-tags-empty">无法读取标签</p>}
      {tags?.tags.length === 0 && <p className="viewer-tags-empty">暂无标签</p>}
      {tags && GROUPS.map((group) => {
        const members = tags.tags.filter(({ tag }) => tag.namespace === group.value);
        if (members.length === 0) return null;
        return (
          <div key={group.value} className="viewer-tag-group">
            <h5>{group.label}</h5>
            <ul aria-label={group.label}>
              {members.map(({ tag, origins }) => {
                const standing = tagStanding(origins);
                const grouped = display.style === "grouped";
                return (
                  <li key={tag.id} className={standing.kind === "manual" ? "is-manual" : undefined}
                    data-band={grouped ? undefined : chipBand(origins, display)}
                    title={[...new Set(origins.map((o) => originLine(o, display)))].join("\n")}>
                    <span className="viewer-tag-name">{tag.name}</span>
                    <TagMarks tag={tag} />
                    {grouped && standing.kind === "model" && standing.score !== null && <ConfidenceMeter score={standing.score} />}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
