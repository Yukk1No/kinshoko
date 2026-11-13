import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Name } from "../ui/Name";
import { formatNumber } from "../i18n/format";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Link2, PenLine, Plus, Tags, Trash2, X } from "lucide-react";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import { TagMarks, tagName, type Lens } from "../search/SearchBox";
import { NameInput } from "../ui/NameInput";
import { Tip } from "../ui/Tip";
import { escape, kindLabel, PickTag } from "./TagGroupsRows";

// 标签分组页的一行（分组头、成员、加标签），原样从 TagGroupsPane.tsx 移出。

const moved = (ids: string[], index: number, delta: number) => {
  const result = [...ids];
  const other = index + delta;
  [result[index], result[other]] = [result[other], result[index]];
  return result;
};

type Props = {
  group: CatalogGroupView;
  index: number;
  groups: CatalogGroupView[];
  fresh: boolean;
  busy: boolean;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  picking: string | null;
  setPicking: (id: string | null) => void;
  onBrowse?: (tagIds: string[]) => void;
  edit: (action: CatalogGroupEdit) => Promise<unknown>;
  remove: (group: CatalogGroupView) => void;
  remember: (fallback?: string) => void;
  section: RefObject<HTMLElement | null>;
  lens: Lens;
};

export function GroupRow({
  group,
  index,
  groups,
  fresh,
  busy,
  renaming,
  setRenaming,
  picking,
  setPicking,
  onBrowse,
  edit,
  remove,
  remember,
  section,
  lens,
}: Props) {
  const { t } = useTranslation("tagGroups");
  const custom = group.namespace === null;
  const origin = group.sources?.length
    ? group.sources
        .map((source) => t("group.originItem", { library: source.libraryName, group: source.groupName }))
        .join(t("group.originSeparator"))
    : null;
  const ids = group.tags.map((member) => member.tag.id);
  return (
    <div key={group.id} role="group" aria-label={fresh ? group.name : undefined} className="k-group">
      {renaming === group.id ? (
        <div className="k-group-head is-renaming" onKeyDown={(e) => escape(e, () => {})}>
          <span className="k-group-icon" aria-hidden="true">
            <Tags size={16} />
          </span>
          <NameInput
            label={t("group.rename")}
            initial={group.name}
            onDone={(name) => {
              setRenaming(null);
              remember(`${group.id}:rename`);
              if (name && name !== group.name) void edit({ kind: "rename", groupId: group.id, name });
            }}
          />
        </div>
      ) : (
        fresh && (
          <div className="k-group-head">
            <span className="k-group-icon" aria-hidden="true">
              <Tags size={16} />
            </span>
            <Tip
              label={
                (origin ? t("group.origin", { origin }) + "\n" : "") +
                (onBrowse && group.tags.length ? t("group.browseTitle") : t("group.renameTitle"))
              }
              align="start"
            >
              <button
                type="button"
                className="k-group-name"
                data-focus-key={`${group.id}:name`}
                aria-label={t("group.nameCount", { name: group.name, count: group.tags.length })}
                disabled={busy || !onBrowse || !group.tags.length}
                onClick={() => onBrowse?.(ids)}
                onDoubleClick={() => setRenaming(group.id)}
              >
                <Name className="k-group-label k-label">{group.name}</Name>
                {origin && (
                  <span className="k-group-origin" role="img" aria-label={t("group.origin", { origin })}>
                    <Link2 size={14} aria-hidden="true" />
                  </span>
                )}
              </button>
            </Tip>
            <span className="k-group-acts">
              <Tip label={t("group.renameAction")}>
                <button
                  type="button"
                  className="k-icon-btn is-sm"
                  data-focus-key={`${group.id}:rename`}
                  aria-label={t("group.renameLabel", { name: group.name })}
                  disabled={busy}
                  onClick={() => setRenaming(group.id)}
                >
                  <PenLine size={14} aria-hidden="true" />
                </button>
              </Tip>
              <Tip label={t("group.up")}>
                <button
                  type="button"
                  className="k-icon-btn is-sm"
                  data-focus-key={`${group.id}:up`}
                  aria-label={t("group.upLabel", { name: group.name })}
                  disabled={busy || index === 0}
                  onClick={() =>
                    void edit({
                      kind: "orderGroups",
                      groupIds: moved(
                        groups.map((g) => g.id),
                        index,
                        -1,
                      ),
                    })
                  }
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
              </Tip>
              <Tip label={t("group.down")}>
                <button
                  type="button"
                  className="k-icon-btn is-sm"
                  data-focus-key={`${group.id}:down`}
                  aria-label={t("group.downLabel", { name: group.name })}
                  disabled={busy || index === groups.length - 1}
                  onClick={() =>
                    void edit({
                      kind: "orderGroups",
                      groupIds: moved(
                        groups.map((g) => g.id),
                        index,
                        1,
                      ),
                    })
                  }
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
              </Tip>
              <Tip label={t("group.delete")}>
                <button
                  type="button"
                  className="k-icon-btn is-sm is-danger"
                  data-focus-key={`${group.id}:delete`}
                  aria-label={t("group.deleteLabel", { name: group.name })}
                  disabled={busy}
                  onClick={() => remove(group)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </Tip>
            </span>
            {custom ? (
              <span className="k-group-count k-label">{t("group.tagCount", { count: group.tags.length })}</span>
            ) : (
              <span className="k-pill">
                <span className="k-label">{group.namespace && kindLabel(group.namespace)}</span>
              </span>
            )}
          </div>
        )
      )}
      {((fresh && (group.tags.length > 0 || custom)) || picking === group.id) && (
        <ul className="k-group-members">
          {fresh &&
            group.tags.map(({ tag, count }, memberIndex) => {
              const name = tagName(tag);
              return (
                <li key={tag.id} className="k-group-member">
                  <button
                    type="button"
                    className="k-group-chip"
                    data-focus-key={`${group.id}:${tag.id}:chip`}
                    aria-label={t("member.count", { name, count })}
                    disabled={!onBrowse}
                    onClick={() => onBrowse?.([tag.id])}
                  >
                    <span className="k-group-chip-name k-label">
                      {name}
                      <TagMarks tag={tag} />
                    </span>
                    <span className="k-group-chip-count k-label">{formatNumber(count)}</span>
                  </button>
                  {custom && (
                    <span className="k-group-member-acts">
                      <Tip label={t("member.prev")}>
                        <button
                          type="button"
                          className="k-group-chip-x"
                          data-focus-key={`${group.id}:${tag.id}:prev`}
                          aria-label={t("member.prevLabel", { tag: name, group: group.name })}
                          disabled={busy || memberIndex === 0}
                          onClick={() =>
                            void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(ids, memberIndex, -1) })
                          }
                        >
                          <ArrowLeft size={12} aria-hidden="true" />
                        </button>
                      </Tip>
                      <Tip label={t("member.next")}>
                        <button
                          type="button"
                          className="k-group-chip-x"
                          data-focus-key={`${group.id}:${tag.id}:next`}
                          aria-label={t("member.nextLabel", { tag: name, group: group.name })}
                          disabled={busy || memberIndex === group.tags.length - 1}
                          onClick={() =>
                            void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(ids, memberIndex, 1) })
                          }
                        >
                          <ArrowRight size={12} aria-hidden="true" />
                        </button>
                      </Tip>
                      <Tip label={t("member.remove")}>
                        <button
                          type="button"
                          className="k-group-chip-x"
                          data-focus-key={`${group.id}:${tag.id}:remove`}
                          aria-label={t("member.removeLabel", { tag: name, group: group.name })}
                          disabled={busy}
                          onClick={() => void edit({ kind: "removeMembers", groupId: group.id, tagIds: [tag.id] })}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </Tip>
                    </span>
                  )}
                </li>
              );
            })}
          {picking === group.id ? (
            <PickTag
              lens={lens}
              members={ids}
              onCancel={() => {
                // 收起后焦点回到“加标签”，不丢到页面上。
                setPicking(null);
                requestAnimationFrame(() =>
                  section.current?.querySelector<HTMLElement>(`[data-focus-key="${group.id}:add"]`)?.focus(),
                );
              }}
              onPick={(tag) => {
                setPicking(null);
                remember(`${group.id}:add`);
                void edit({ kind: "addMembers", groupId: group.id, tagIds: [tag.id] });
              }}
            />
          ) : (
            custom && (
              <li>
                <button
                  type="button"
                  className="k-group-add"
                  data-focus-key={`${group.id}:add`}
                  aria-label={t("member.addLabel", { group: group.name })}
                  disabled={busy}
                  onClick={() => setPicking(group.id)}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span className="k-label">{t("member.add")}</span>
                </button>
              </li>
            )
          )}
        </ul>
      )}
    </div>
  );
}
