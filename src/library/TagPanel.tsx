import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResolvedTagIdentity } from "../bindings/ResolvedTagIdentity";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { ImageTag } from "../bindings/ImageTag";
import type { TagRef } from "../bindings/TagRef";
import type { VocabularyTag } from "../bindings/VocabularyTag";
import { addTagAlias, catalogImageTags, editTags, removeTagAlias, vocabulary } from "../ipc";
import { LIMIT, TagMarks, tagName, useCandidateState } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { tagOption } from "../search/tagOptions";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { TagChip } from "../tags/TagChip";
import { UntranslatedRename } from "../tags/UntranslatedRename";
import { tagStanding, type TagStanding } from "../tags/tagConfidence";
import { useTagDisplay } from "../tags/TagDisplayContext";
import { AtSign, Ban, Check, Plus, Sparkles, Tags, Undo2, X } from "lucide-react";
import { Tip } from "../ui/Tip";

type Props = {
  libraryId: string;
  /** 选中的参考图；只有一张时列出它的标签。 */
  ids: string[];
  /** 浏览视角：安全模式是否开启（候选按它取得）。 */
  safe: boolean;
  /** 词表代次（词表、图片或安全模式变化时递增）：重新取得标签、别名与候选。 */
  generation: number;
  onError: (error: unknown) => void;
};

const NAMESPACES: TagNamespace[] = ["general", "artist", "character", "work"];
/** 写了类别前缀时取多少个候选再按类别筛（后端只按名称截断）。 */
const PREFIXED_POOL = 500;

type Group = { kind: TagStanding["kind"]; tags: ImageTag[] };

/**
 * 按出处分组（#482）：你添加的 / 导入 / 打标模型（按可信度从高到低，没有分数的在后）；空组不列。
 * 不分组时也按这个次序排成一列：人写的在前，模型标签在后。
 */
function groupByStanding(tags: ImageTag[]): Group[] {
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

const byId = (tag: TagLabel): TagRef => ({ kind: "id", id: tag.id });

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
const decisionOf = (event: { type: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): TagEdit["kind"] =>
  event.shiftKey ? "clear" : (event.type === "keydown" ? event.altKey : event.ctrlKey || event.metaKey) ? "reject" : "add";

/**
 * 选中参考图的标签（#51）：只选一张时列出有效标签及出处、被否决的标签，可以确认、否决或清除
 * 人工标签决定，给标签加别名；选几张都能按命名空间与名称（或别名）一次添加、否决或清除。
 * 人工标签决定优先于来源事实，重新打标或重新迁入不会覆盖。
 */
export function TagPanel({ libraryId, ids, safe, generation, onError }: Props) {
  const { t } = useTranslation("tags");
  const single = ids.length === 1 ? ids[0] : null;
  // 读到的标签记着它属于哪一次读取：切换选中图时先留着上一张的（不可操作），新的到了再换（#158）。
  const [loaded, setLoaded] = useState<{ key: string; tags: ImageTags; identities: ResolvedTagIdentity[] } | null>(null);
  const [aliasFor, setAliasFor] = useState<TagLabel | null>(null);
  const [namespace, setNamespace] = useState<TagNamespace>("general");
  const [text, setText] = useState("");
  const [refresh, setRefresh] = useState(0);
  const display = useTagDisplay();
  const identityKey = JSON.stringify([libraryId, ids, safe, generation]);
  const currentKey = useRef(identityKey);
  currentKey.current = identityKey;
  useEffect(() => { currentKey.current = identityKey; return () => { currentKey.current = ""; }; }, [identityKey]);
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
      (error) => { if (alive) { setLoaded(null); onError(error); } },
    );
    return () => {
      alive = false;
    };
  }, [libraryId, single, safe, generation, refresh, onError, loadKey, lang]);
  const tags = loaded?.tags ?? null;
  const identities = loaded?.identities ?? [];
  const stale = loaded !== null && loaded.key !== loadKey;

  // 换了选中的图，别名编辑跟着关掉。
  useEffect(() => setAliasFor(null), [single]);

  const edit = (edits: TagEdit[]) =>
    editTags(libraryId, ids, edits).then(
      () => { if (currentKey.current === identityKey) setRefresh((n) => n + 1); },
      (e) => { if (currentKey.current === identityKey) onError(e); },
    );

  // 写了类别前缀的按前缀，否则按新建项上选的类别。
  const parsed = parseTyped(text, (value) => t(`namespace.${value}`));
  const kind = parsed.namespace ?? namespace;
  const typed = (): TagRef | null => parsed.name ? { kind: "named", namespace: kind, name: parsed.name, lang } : null;
  const decide = (kind: TagEdit["kind"], tag: TagRef | null = typed()) => {
    if (!tag) return;
    setText("");
    // 新建项上选的类别只管这一次。
    setNamespace("general");
    void edit([{ kind, tag }]);
  };

  // 名称偏好保存后重读标签（词表变化事件也会让代次递增）。
  const renamed = () => { if (currentKey.current === identityKey) setRefresh((n) => n + 1); };
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
  const { list: candidates, ready } = useCandidateState({ libraryId, safe, generation, picking: true }, query, undefined,
    parsed.namespace ? PREFIXED_POOL : LIMIT + has.size);
  const found = candidates.filter((c) => !has.has(c.tag.id) && keepKind(c)).slice(0, LIMIT);
  const exact = candidates.some((c) => c.tag.namespace === kind && (c.tag.name === query || c.via === query));
  // 候选行尾：排除；选了几张时还有改回自动（单张的已有标签在标签自己的浮层里改回）。悬停“排除”时名称划掉，示意结果。
  const rowActions = (tag: TagLabel) => {
    const name = tagName(tag);
    return <>
      <Tip label={t("panel.rejectTitle")} keys="Alt+Enter"><button type="button" tabIndex={-1} className="k-option-act is-reject" aria-label={t("panel.rejectLabel", { name })} aria-keyshortcuts="Alt+Enter"
        onClick={() => decide("reject", byId(tag))}><Ban size={14} aria-hidden="true" /></button></Tip>
      {ids.length > 1 && <Tip label={t("panel.revert")} keys="Shift+Enter"><button type="button" tabIndex={-1} className="k-option-act" aria-label={t("panel.clearLabel", { name })} aria-keyshortcuts="Shift+Enter"
        onClick={() => decide("clear", byId(tag))}><Undo2 size={14} aria-hidden="true" /></button></Tip>}
    </>;
  };
  // 新建项行尾：选类别。写了类别前缀时点别的类别，去掉前缀改用点的那个。
  // 选了几张时末尾还有改回自动：在所有图上都被排除的标签不在候选里（候选只列有图的），只能按输入的名称改回。
  const kindPicker = <>
    <span className="k-tag-kinds" role="radiogroup" aria-label={t("panel.namespaceLabel")}>
      {NAMESPACES.map((value) => <button key={value} type="button" tabIndex={-1} role="radio" aria-checked={value === kind}
        className="k-tag-kind" onClick={() => { if (parsed.namespace) setText(query); setNamespace(value); }}>
        <span className="k-label">{t(`namespaceOption.${value}`)}</span></button>)}
    </span>
    {ids.length > 1 && <Tip label={t("panel.revert")} keys="Shift+Enter"><button type="button" tabIndex={-1} className="k-option-act k-tag-kinds-clear"
      aria-label={t("panel.clearLabel", { name: query })} aria-keyshortcuts="Shift+Enter" onClick={() => decide("clear")}><Undo2 size={14} aria-hidden="true" /></button></Tip>}
  </>;
  const addOptions: (ComboboxOption & { tag: TagLabel | null })[] = found.map((c) => ({ ...tagOption(c, query), actions: rowActions(c.tag) }));
  if (query && ready && !exact) addOptions.push({ id: "create", create: true, tag: null, label: t("panel.create", { name: query }), actions: kindPicker });
  const chip = ({ tag, origins }: ImageTag, meter: boolean) => {
    const manual = origins.some((o) => o.kind === "manual");
    const name = tagName(tag);
    const unified = identities.filter((identity) => identity.localTagId === tag.id);
    return (
      <TagChip key={tag.id} tag={tag} origins={origins} meter={meter} rename={renameFor(tag)}
        notes={unified.map((identity) => t("panel.unifiedAs", { name: tagName(identity.tag) }))}
        actions={<>
          {manual ? (
            <button type="button" className="k-tag-tip-btn" aria-label={t("panel.clearLabel", { name })}
              onClick={() => decide("clear", byId(tag))}><Undo2 size={12} aria-hidden="true" /><span className="k-label">{t("panel.revert")}</span></button>
          ) : (
            <Tip label={t("panel.keepTitle")}><button type="button" className="k-tag-tip-btn" aria-label={t("panel.keepLabel", { name })}
              onClick={() => decide("add", byId(tag))}><Check size={12} aria-hidden="true" /><span className="k-label">{t("panel.keep")}</span></button></Tip>
          )}
          <Tip label={t("panel.rejectTitle")}><button type="button" className="k-tag-tip-btn" aria-label={t("panel.rejectLabel", { name })}
            onClick={() => decide("reject", byId(tag))}><Ban size={12} aria-hidden="true" /><span className="k-label">{t("panel.reject")}</span></button></Tip>
          <button type="button" className="k-tag-tip-btn" aria-label={t("panel.aliasesLabel", { name })}
            onClick={() => setAliasFor(tag)}><AtSign size={12} aria-hidden="true" /><span className="k-label">{t("panel.aliases")}</span></button>
        </>} />
    );
  };
  // 详情面板的标签（#98，design/ui-system/interface-text-rules.md 与 interface-terms.md；#160）：现有标签是小标签，只写名称；
  // 出处、可信度和“保留／改回自动／不要／别名”在悬停或聚焦时的浮层里。外观按设置：B 按准不准分三档（#482），
  // C 按出处分组加刻度。两种都是人写的在前、模型标签在后。添加只有一个输入框：候选行回车添加、Alt+回车或行尾按钮排除，
  // 新建项的行尾选类别；不另放按钮行。
  return (
    <section className="tag-panel insp-sec k-tags" aria-label={t("panel.label")}>
      <h4><Tags size={13} aria-hidden="true" />{t("panel.title")}</h4>
      {tags && (
        <>
          {display.style === "grouped" && tags.tags.length > 0
            ? groupByStanding(tags.tags).map((group) => (
              <div key={group.kind} className="k-tag-group">
                <p className="k-tags-sub">{group.kind === "model" && <Sparkles size={12} aria-hidden="true" />}{t(`panel.group.${group.kind}`)}</p>
                <ul className="tag-list k-tag-chips" aria-label={t(`panel.group.${group.kind}`)} aria-busy={stale} inert={stale}>
                  {group.tags.map((entry) => chip(entry, group.kind === "model"))}
                </ul>
              </div>
            ))
            : <ul className="tag-list k-tag-chips" aria-label={t("panel.active")} aria-busy={stale} inert={stale}>
              {tags.tags.length === 0 && <li className="tag-empty k-tags-empty">{t("panel.empty")}</li>}
              {groupByStanding(tags.tags).flatMap((group) => group.tags).map((entry) => chip(entry, false))}
            </ul>}
          {tags.rejected.length > 0 && (<>
            <p className="k-tags-sub">{t("panel.excluded")}</p>
            <ul className="tag-list tag-list-rejected k-tag-chips" aria-label={t("panel.rejected")} aria-busy={stale} inert={stale}>
              {tags.rejected.map((tag) => {
                const name = tagName(tag);
                const rename = renameFor(tag);
                return (
                  <li key={tag.id} className="tag-row k-tag-chip is-rejected">
                    <span className="tag-name">{name}</span>
                    <TagMarks tag={tag} untranslated={rename && <UntranslatedRename tag={tag} catalogId={rename.catalogId} onSaved={rename.onSaved} />} />
                    <Tip label={t("panel.restoreTitle")}><button type="button" className="k-tag-restore" aria-label={t("panel.restoreLabel", { name })}
                      onClick={() => decide("clear", byId(tag))}>{t("panel.restore")}</button></Tip>
                  </li>
                );
              })}
            </ul>
          </>)}
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
            if (e.key === "Enter" && !ready) { e.preventDefault(); decide(decisionOf(e)); }
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
  );
}

/** 一个标签的别名：列出已有的，加新的叫法或去掉一个。别名随词表（vocabulary）刷新。 */
function AliasEditor({
  libraryId,
  tag,
  generation,
  onError,
  onClose,
}: {
  libraryId: string;
  tag: TagLabel;
  generation: number;
  onError: (error: unknown) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("tags");
  const lang = useUiLang();
  const [entry, setEntry] = useState<VocabularyTag | null>(null);
  const [draft, setDraft] = useState("");
  const name = tagName(tag);

  useEffect(() => {
    let alive = true;
    vocabulary(libraryId).then(
      (v) => alive && setEntry(v.tags.find((t) => t.id === tag.id) ?? null),
      (e) => alive && onError(e),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, tag.id, generation, onError]);

  const add = () => {
    const alias = draft.trim();
    if (!alias) return;
    setDraft("");
    addTagAlias(libraryId, tag.id, { name: alias, lang }).catch((e) => onError(e));
  };

  return (
    <div className="tag-alias-editor k-tag-alias" role="dialog" aria-label={t("panel.aliasesLabel", { name })}>
      <p className="insp-hint">{t("alias.hint", { name })}</p>
      {entry && entry.aliases.length > 0 ? (
        <ul className="tag-aliases k-tag-chips">
          {entry.aliases.map((a) => (
            <li key={a.name}>
              <span>{a.name}</span>
              <Tip label={t("alias.removeTitle")}><button
                type="button"
                className="k-icon-btn is-xs"
                aria-label={t("alias.removeLabel", { name: a.name })}
                onClick={() => removeTagAlias(libraryId, tag.id, a.name).catch((e) => onError(e))}
              >
                <X size={12} aria-hidden="true" />
              </button></Tip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="selection-hint">{t("alias.none")}</p>
      )}
      <input
        className="k-input"
        placeholder={t("alias.placeholder")}
        aria-label={t("alias.placeholder")}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="k-tag-alias-acts">
        <button type="button" className="k-btn is-sm" onClick={onClose}>
          <span className="k-label">{t("alias.done")}</span>
        </button>
        <button type="button" className="k-btn is-sm is-primary" disabled={!draft.trim()} onClick={add}>
          <span className="k-label">{t("alias.add")}</span>
        </button>
      </span>
    </div>
  );
}
