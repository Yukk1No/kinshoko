import { useEffect, useState } from "react";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagNamespace } from "../bindings/TagNamespace";
import { imageTags } from "../ipc";
import { originText } from "../library/TagPanel";
import { TagMarks, UI_LANG } from "../search/SearchBox";

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
 * 来源与分数弱化显示，人工添加的不标。编辑仍在主窗口的详情面板里做。
 */
export function ViewerTags({ libraryId, imageId, reloadKey }: Props) {
  const [tags, setTags] = useState<ImageTags | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setTags(null);
    setFailed(false);
    imageTags(libraryId, imageId, UI_LANG).then((value) => { if (alive) setTags(value); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [libraryId, imageId, reloadKey]);

  return (
    <section className="viewer-tags" aria-label="标签">
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
                const manual = origins.some((o) => o.kind === "manual");
                return (
                  <li key={tag.id}>
                    <span className="viewer-tag-name">{tag.name}</span>
                    <TagMarks tag={tag} />
                    {!manual && origins.map((o, i) => <span key={i} className="viewer-tag-from">{originText(o)}</span>)}
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
