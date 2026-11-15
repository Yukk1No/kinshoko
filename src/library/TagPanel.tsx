import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ResolvedTagIdentity } from "../bindings/ResolvedTagIdentity";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { ImageTag } from "../bindings/ImageTag";
import type { TagRef } from "../bindings/TagRef";
import { catalogImageTags, editTags } from "../ipc";
import { LIMIT, TagMarks, tagName, useCandidateState } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { tagOption } from "../search/tagOptions";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { TagChip } from "../tags/TagChip";
import { UntranslatedRename } from "../tags/UntranslatedRename";
import { useTagDisplay } from "../tags/TagDisplayContext";
import { AtSign, Ban, Check, Plus, Sparkles, Tags, Undo2 } from "lucide-react";
import { Tip } from "../ui/Tip";
import { AliasEditor } from "./TagAliasEditor";
import { decisionOf, groupByStanding, NAMESPACES, ordered, parseTyped } from "./tagPanelInput";

export { AliasEditor } from "./TagAliasEditor";
export { parseTyped } from "./tagPanelInput";

type Props = {
  libraryId: string;
  /** 选中的参考图；只有一张时列出它的标签。 */
  ids: string[];
  /** 浏览视角：安全模式是否开启（候选按它取得）。 */
  safe: boolean;
  /** 词表代次（词表、图片或安全模式变化时递增）：重新取得标签、别名与候选。 */
  generation: number;
  onError: (error: unknown) => void;
  /** 属性表的最后一行（#518）：分级的名称与控件，由详情面板在读到这张图的详情后给出。 */
  rating?: { label: string; control: ReactNode };
};

/** 一级标签（#518）：这三类在文件名下面的属性表里各占一行，与分级同级；其余是一般标签，留在“标签”区。 */
const PRIMARY: TagNamespace[] = ["artist", "character", "work"];
/** 写了类别前缀时取多少个候选再按类别筛（后端只按名称截断）。 */
const PREFIXED_POOL = 500;

const byId = (tag: TagLabel): TagRef => ({ kind: "id", id: tag.id });

/**
 * 选中参考图的标签（#51）：只选一张时列出有效标签及出处、被否决的标签，可以确认、否决或清除
 * 人工标签决定，给标签加别名；选几张都能按命名空间与名称（或别名）一次添加、否决或清除。
 * 人工标签决定优先于来源事实，重新打标或重新迁入不会覆盖。
 */
export function TagPanel({ libraryId, ids, safe, generation, onError, rating }: Props) {
  const { t } = useTranslation("tags");
  const single = ids.length === 1 ? ids[0] : null;
  // 读到的标签记着它属于哪一次读取：切换选中图时先留着上一张的（不可操作），新的到了再换（#158）。
  const [loaded, setLoaded] = useState<{ key: string; tags: ImageTags; identities: ResolvedTagIdentity[] } | null>(
    null,
  );
  const [aliasFor, setAliasFor] = useState<TagLabel | null>(null);
  const [namespace, setNamespace] = useState<TagNamespace>("general");
  const [text, setText] = useState("");
  const [refresh, setRefresh] = useState(0);
  const display = useTagDisplay();
  const identityKey = JSON.stringify([libraryId, ids, safe, generation]);
  const currentKey = useRef(identityKey);
  currentKey.current = identityKey;
  useEffect(() => {
    currentKey.current = identityKey;
    return () => {
      currentKey.current = "";
    };
  }, [identityKey]);
  const lang = useUiLang();
  const loadKey = JSON.stringify([identityKey, refresh, lang]);

  useEffect(() => {
    let alive = true;
    if (!single) {
      setLoaded(null);
      return;
    }
    // 统一标签身份与有效标签出自同一次查询（#158）。
    catalogImageTags(libraryId, single, lang).then(
      (value) => alive && setLoaded({ key: loadKey, tags: value.image, identities: value.identities }),
      (error) => {
        if (alive) {
          setLoaded(null);
          onError(error);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [libraryId, single, onError, loadKey, lang]);
  const tags = loaded?.tags ?? null;
  const identities = loaded?.identities ?? [];
  const stale = loaded !== null && loaded.key !== loadKey;

  // 换了选中的图，别名编辑跟着关掉。在渲染中比较，换图的这一帧就不显示上一张的编辑。
  const [aliasImage, setAliasImage] = useState(single);
  if (aliasImage !== single) {
    setAliasImage(single);
    setAliasFor(null);
  }

  const edit = (edits: TagEdit[]) =>
    editTags(libraryId, ids, edits).then(
      () => {
        if (currentKey.current === identityKey) setRefresh((n) => n + 1);
      },
      (e) => {
        if (currentKey.current === identityKey) onError(e);
      },
    );

  // 写了类别前缀的按前缀，否则按新建项上选的类别。
  const parsed = parseTyped(text, (value) => t(`namespace.${value}`));
  const kind = parsed.namespace ?? namespace;
  const typed = (): TagRef | null => (parsed.name ? { kind: "named", namespace: kind, name: parsed.name, lang } : null);
  const decide = (kind: TagEdit["kind"], tag: TagRef | null = typed()) => {
    if (!tag) return;
    setText("");
    // 新建项上选的类别只管这一次。
    setNamespace("general");
    void edit([{ kind, tag }]);
  };

  // 名称偏好保存后重读标签（词表变化事件也会让代次递增）。
  const renamed = () => {
    if (currentKey.current === identityKey) setRefresh((n) => n + 1);
  };
  const renameFor = (tag: TagLabel) => {
    const identity = identities.find((entry) => entry.localTagId === tag.id);
    return identity && { catalogId: identity.catalogId, onSaved: renamed };
  };

  // 添加标签的候选：已经有的标签不列；最后是新建项，输入的正是某个标签的名称或别名时不给。
  const query = parsed.name;
  const has = new Set(single ? tags?.tags.map((entry) => entry.tag.id) : []);
  const keepKind = (c: { tag: TagLabel }) => parsed.namespace === null || c.tag.namespace === parsed.namespace;
  // 已经有的标签之后要去掉：多取这么多个，去掉后仍能列满。写了类别前缀时，候选在截断之后才按类别筛，
  // 排在前面的别的类别会把这个类别挤掉：多取一大截再筛。
  const { list: candidates, ready } = useCandidateState(
    { libraryId, safe, generation, picking: true },
    query,
    undefined,
    parsed.namespace ? PREFIXED_POOL : LIMIT + has.size,
  );
  const found = candidates.filter((c) => !has.has(c.tag.id) && keepKind(c)).slice(0, LIMIT);
  const exact = candidates.some((c) => c.tag.namespace === kind && (c.tag.name === query || c.via === query));
  // 候选行尾：排除；选了几张时还有改回自动（单张的已有标签在标签自己的浮层里改回）。悬停“排除”时名称划掉，示意结果。
  const rowActions = (tag: TagLabel) => {
    const name = tagName(tag);
    return (
      <>
        <Tip label={t("panel.reject")} keys="Alt+Enter">
          <button
            type="button"
            tabIndex={-1}
            className="k-option-act is-reject"
            aria-label={t("panel.rejectLabel", { name })}
            aria-keyshortcuts="Alt+Enter"
            onClick={() => decide("reject", byId(tag))}
          >
            <Ban size={14} aria-hidden="true" />
          </button>
        </Tip>
        {ids.length > 1 && (
          <Tip label={t("panel.revert")} keys="Shift+Enter">
            <button
              type="button"
              tabIndex={-1}
              className="k-option-act"
              aria-label={t("panel.clearLabel", { name })}
              aria-keyshortcuts="Shift+Enter"
              onClick={() => decide("clear", byId(tag))}
            >
              <Undo2 size={14} aria-hidden="true" />
            </button>
          </Tip>
        )}
      </>
    );
  };
  // 新建项行尾：选类别。写了类别前缀时点别的类别，去掉前缀改用点的那个。
  // 选了几张时末尾还有改回自动：在所有图上都被排除的标签不在候选里（候选只列有图的），只能按输入的名称改回。
  const kindPicker = (
    <>
      <span className="k-tag-kinds" role="radiogroup" aria-label={t("panel.namespaceLabel")}>
        {NAMESPACES.map((value) => (
          <button
            key={value}
            type="button"
            tabIndex={-1}
            role="radio"
            aria-checked={value === kind}
            className="k-tag-kind"
            onClick={() => {
              if (parsed.namespace) setText(query);
              setNamespace(value);
            }}
          >
            <span className="k-label">{t(`namespaceOption.${value}`)}</span>
          </button>
        ))}
      </span>
      {ids.length > 1 && (
        <Tip label={t("panel.revert")} keys="Shift+Enter">
          <button
            type="button"
            tabIndex={-1}
            className="k-option-act k-tag-kinds-clear"
            aria-label={t("panel.clearLabel", { name: query })}
            aria-keyshortcuts="Shift+Enter"
            onClick={() => decide("clear")}
          >
            <Undo2 size={14} aria-hidden="true" />
          </button>
        </Tip>
      )}
    </>
  );
  const addOptions: (ComboboxOption & { tag: TagLabel | null })[] = found.map((c) => ({
    ...tagOption(c, query),
    actions: rowActions(c.tag),
  }));
  if (query && ready && !exact)
    addOptions.push({
      id: "create",
      create: true,
      tag: null,
      label: t("panel.create", { name: query }),
      actions: kindPicker,
    });
  const chip = ({ tag, origins }: ImageTag, meter: boolean, bare = false) => {
    const manual = origins.some((o) => o.kind === "manual");
    const name = tagName(tag);
    const unified = identities.filter((identity) => identity.localTagId === tag.id);
    return (
      <TagChip
        key={tag.id}
        tag={tag}
        origins={origins}
        meter={meter}
        bare={bare}
        rename={renameFor(tag)}
        notes={unified.map((identity) => t("panel.unifiedAs", { name: tagName(identity.tag) }))}
        actions={
          <>
            {manual ? (
              <button
                type="button"
                className="k-tag-tip-btn"
                aria-label={t("panel.clearLabel", { name })}
                onClick={() => decide("clear", byId(tag))}
              >
                <Undo2 size={12} aria-hidden="true" />
                <span className="k-label">{t("panel.revert")}</span>
              </button>
            ) : (
              <button
                type="button"
                className="k-tag-tip-btn"
                aria-label={t("panel.keepLabel", { name })}
                onClick={() => decide("add", byId(tag))}
              >
                <Check size={12} aria-hidden="true" />
                <span className="k-label">{t("panel.keep")}</span>
              </button>
            )}
            <button
              type="button"
              className="k-tag-tip-btn"
              aria-label={t("panel.rejectLabel", { name })}
              onClick={() => decide("reject", byId(tag))}
            >
              <Ban size={12} aria-hidden="true" />
              <span className="k-label">{t("panel.reject")}</span>
            </button>
            <button
              type="button"
              className="k-tag-tip-btn"
              aria-label={t("panel.aliasesLabel", { name })}
              onClick={() => setAliasFor(tag)}
            >
              <AtSign size={12} aria-hidden="true" />
              <span className="k-label">{t("panel.aliases")}</span>
            </button>
          </>
        }
      />
    );
  };
  // 详情面板的标签（#98，#160，#518）：作者、角色、作品是一级标签，在文件名下面的属性表里各占一行，行首写类别，标签上不再写
  // 前缀，没有标签的类别不占行；分级是属性表的最后一行。“标签”区只放一般标签。标签上只写名称，出处、可信度和
  // “保留／改回自动／排除／别名”在悬停或聚焦时的浮层里。外观按设置：B 按准不准分三档（#482），C 按出处分组加刻度。
  // 两种都是人写的在前、模型标签在后。添加只有一个输入框：候选行回车添加、Alt+回车或行尾按钮排除，新建项的行尾选类别。
  const all = tags?.tags ?? [];
  const general = all.filter((entry) => entry.tag.namespace === "general");
  const primary = PRIMARY.map((value) => ({
    namespace: value,
    tags: ordered(all.filter((entry) => entry.tag.namespace === value)),
  })).filter((row) => row.tags.length > 0);
  const grouped = display.style === "grouped";
  return (
    <>
      {(primary.length > 0 || rating) && (
        <dl className="insp-props k-tags">
          {primary.map((row) => (
            <div key={row.namespace} className="insp-prop">
              <dt>{t(`namespaceOption.${row.namespace}`)}</dt>
              <dd>
                <ul
                  className="tag-list k-tag-chips"
                  aria-label={t(`namespaceOption.${row.namespace}`)}
                  aria-busy={stale}
                  inert={stale}
                >
                  {row.tags.map((entry) => chip(entry, grouped, true))}
                </ul>
              </dd>
            </div>
          ))}
          {rating && (
            <div className="insp-prop is-rating">
              <dt>{rating.label}</dt>
              <dd>{rating.control}</dd>
            </div>
          )}
        </dl>
      )}
      {/* aria-busy：这张图的标签还没读到，或还留着上一张的（src/perf/inspector.ts 靠它判断面板显示完了）。 */}
      <section
        className="tag-panel insp-sec k-tags"
        aria-label={t("panel.label")}
        aria-busy={single !== null && (tags === null || stale)}
      >
        <h4>
          <Tags size={13} aria-hidden="true" />
          {t("panel.title")}
        </h4>
        {tags && (
          <>
            {grouped && general.length > 0
              ? groupByStanding(general).map((group) => (
                  <div key={group.kind} className="k-tag-group">
                    <p className="k-tags-sub">
                      {group.kind === "model" && <Sparkles size={12} aria-hidden="true" />}
                      {t(`panel.group.${group.kind}`)}
                    </p>
                    <ul
                      className="tag-list k-tag-chips"
                      aria-label={t(`panel.group.${group.kind}`)}
                      aria-busy={stale}
                      inert={stale}
                    >
                      {group.tags.map((entry) => chip(entry, group.kind === "model"))}
                    </ul>
                  </div>
                ))
              : // 只有一级标签时不写“还没有标签”：上面的属性表里已经有了。
                (general.length > 0 || all.length === 0) && (
                  <ul className="tag-list k-tag-chips" aria-label={t("panel.active")} aria-busy={stale} inert={stale}>
                    {all.length === 0 && <li className="tag-empty k-tags-empty">{t("panel.empty")}</li>}
                    {ordered(general).map((entry) => chip(entry, false))}
                  </ul>
                )}
            {tags.rejected.length > 0 && (
              <>
                <p className="k-tags-sub">{t("panel.excluded")}</p>
                <ul
                  className="tag-list tag-list-rejected k-tag-chips"
                  aria-label={t("panel.excluded")}
                  aria-busy={stale}
                  inert={stale}
                >
                  {tags.rejected.map((tag) => {
                    const name = tagName(tag);
                    const rename = renameFor(tag);
                    // 已排除的标签：名称划掉，末尾的图标把它改回自动（与候选行尾的“改回自动”同一个图标）；悬停图标时划线先去掉，示意结果。
                    return (
                      <li key={tag.id} className="tag-row k-tag-chip is-rejected">
                        <span className="tag-name">{name}</span>
                        <TagMarks
                          tag={tag}
                          untranslated={
                            rename && (
                              <UntranslatedRename tag={tag} catalogId={rename.catalogId} onSaved={rename.onSaved} />
                            )
                          }
                        />
                        <Tip label={t("panel.revert")}>
                          <button
                            type="button"
                            className="k-tag-restore"
                            aria-label={t("panel.clearLabel", { name })}
                            onClick={() => decide("clear", byId(tag))}
                          >
                            <Undo2 size={12} aria-hidden="true" />
                          </button>
                        </Tip>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
        <div className="tag-add k-tag-add">
          <Combobox
            className="k-tag-field"
            label={t("panel.field")}
            placeholder={t("panel.placeholder")}
            value={text}
            leading={<Plus size={16} aria-hidden="true" />}
            options={addOptions}
            empty={query && ready && found.length === 0 ? t("panel.noMatch") : undefined}
            onValueChange={setText}
            onSelect={(option, event) => decide(decisionOf(event), option.tag ? byId(option.tag) : typed())}
            onKeyDown={(e) => {
              // 候选还没到时，回车照样按输入的名称添加（Alt+回车排除，Shift+回车改回自动）。
              if (e.key === "Enter" && !ready) {
                e.preventDefault();
                decide(decisionOf(e));
              }
              if (e.key === "Escape") setText("");
            }}
          />
        </div>
        {aliasFor && (
          <AliasEditor
            key={aliasFor.id}
            libraryId={libraryId}
            tag={aliasFor}
            generation={generation}
            onError={onError}
            onClose={() => setAliasFor(null)}
          />
        )}
      </section>
    </>
  );
}
