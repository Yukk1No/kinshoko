import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EagleTagMapping } from "../bindings/EagleTagMapping";
import type { MappedExternal } from "../bindings/MappedExternal";
import type { UnmatchedEagleTag } from "../bindings/UnmatchedEagleTag";
import { eagleTagMapping, errorText, externalSuggestions, mapTagExternal } from "../ipc";
import { TagMarks, tagName } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { Combobox, Highlight } from "../ui/Combobox";

const SUGGESTIONS = 8;

type Props = {
  libraryId: string;
  onClose: () => void;
};

type Done = { name: string; mapped: MappedExternal };

/** 外部名称的候选：匹配的字标出来。 */
export const externalOptions = (names: string[], query: string) =>
  names.map((external) => ({ id: external, label: <Highlight text={external} query={query} /> }));

/** 一个没对上的标签：输入外部名称补上对应，或跳过。 */
function UnmatchedRow({
  item,
  onMapped,
  onSkip,
  onError,
  libraryId,
}: {
  item: UnmatchedEagleTag;
  libraryId: string;
  onMapped: (mapped: MappedExternal) => void;
  onSkip: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation("importing", { keyPrefix: "tagStep" });
  const name = tagName(item.tag);
  const [draft, setDraft] = useState(item.candidates[0] ?? "");
  const [suggestions, setSuggestions] = useState<string[]>(item.candidates);
  const [busy, setBusy] = useState(false);

  const change = (text: string) => {
    setDraft(text);
    if (!text.trim()) {
      setSuggestions(item.candidates);
      return;
    }
    externalSuggestions(text, SUGGESTIONS).then(
      (found) => setSuggestions(found ?? []),
      () => {},
    );
  };
  const submit = async (external = draft.trim()) => {
    if (!external) return;
    setBusy(true);
    try {
      onMapped(await mapTagExternal(libraryId, item.tag.id, external));
    } catch (error) {
      onError(t("mapFailed", { name, error: String(error) }));
      setBusy(false);
    }
  };

  return (
    <li>
      <span className="k-parts">
        <span>{name}<TagMarks tag={item.tag} /></span>
        <span>{t("count", { count: item.count })}</span>
      </span>
      {item.candidates.length > 1 && <span className="import-report-reason">{t("ambiguous")}</span>}
      <Combobox
        label={t("externalLabel", { name })}
        placeholder={t("placeholder")}
        value={draft}
        disabled={busy}
        autoHighlight={false}
        options={externalOptions(suggestions, draft)}
        onValueChange={change}
        onSelect={(option) => { setDraft(option.id); void submit(option.id); }}
        // 有高亮的候选时 Enter 由 Combobox 选它；没有时按输入的名称补上。
        onKeyDown={(e) => { if (e.key === "Enter" && !e.currentTarget.getAttribute("aria-activedescendant")) void submit(); }}
      />
      <button type="button" aria-label={t("mapLabel", { name })} disabled={busy || !draft.trim()} onClick={() => void submit()}>
        {t("map")}
      </button>
      <button type="button" aria-label={t("skipLabel", { name })} disabled={busy} onClick={onSkip}>
        {t("skip")}
      </button>
    </li>
  );
}

/**
 * 迁入向导“标签的外部对应”：Eagle 标签迁入后按名称与翻译表自动匹配外部对应，列出没对上的，
 * 画师可以逐个补上或跳过。跳过的标签早已照常迁入，只是不参与内置近似对应表。
 * 外部对应已属于库内另一个标签（例如打标模型先建了“蓝瞳”）的 Eagle 标签并入那个标签，单独列出（#217）。
 */
export function EagleTagStep({ libraryId, onClose }: Props) {
  const lang = useUiLang();
  const { t } = useTranslation("importing", { keyPrefix: "tagStep" });
  const [mapping, setMapping] = useState<EagleTagMapping | null>(null);
  const [remaining, setRemaining] = useState<UnmatchedEagleTag[]>([]);
  const [done, setDone] = useState<Done[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    eagleTagMapping(libraryId, lang).then(
      (value) => {
        if (!alive) return;
        setMapping(value);
        setRemaining(value.unmatched);
      },
      (e) => alive && setError(t("matchFailed", { error: String(e) })),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, lang]);

  const drop = (id: string) => setRemaining((rows) => rows.filter((r) => r.tag.id !== id));
  const merged = mapping?.matched.filter((m) => m.mergedInto) ?? [];

  return (
    <section className="import-report eagle-tag-step" aria-label={t("label")}>
      <header>
        <span>
          {t("title")}
          {mapping && t("summary", { matched: mapping.matched.length, remaining: remaining.length })}
        </span>
        <button type="button" onClick={onClose}>
          {remaining.length ? t("skipAll") : t("done")}
        </button>
      </header>
      <p>
        {t("noteBefore")}
        <span className="no-external" role="img" aria-label={t("noteIcon")} />
        {t("noteAfter")}
      </p>
      {mapping && mapping.vocabularySize === 0 && (
        <p>{t("noVocabulary")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {merged.length > 0 && (
        <ul aria-label={t("mergedLabel")}>
          {merged.map((m) => (
            <li key={m.tag.id}>
              <span>
                {t("mergedInto", { tag: tagName(m.tag), into: m.mergedInto ? tagName(m.mergedInto) : "" })}
              </span>
              <span className="import-report-reason">{t("mergedReason")}</span>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <ul aria-label={t("mappedLabel")}>
          {done.map((d) => (
            <li key={d.name}>
              <span>
                {d.name} → {d.mapped.external}
              </span>
              {d.mapped.mergedInto && <span className="import-report-reason">{t("mappedMerged")}</span>}
              {!d.mapped.known && (
                <span className="import-report-reason">{t("unknown")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {remaining.length > 0 && (
        <ul aria-label={t("unmatchedLabel")}>
          {remaining.map((item) => (
            <UnmatchedRow
              key={item.tag.id}
              item={item}
              libraryId={libraryId}
              onError={(e) => setError(errorText(e))}
              onSkip={() => drop(item.tag.id)}
              onMapped={(mapped) => {
                setError(null);
                setDone((d) => [...d, { name: tagName(item.tag), mapped }]);
                drop(item.tag.id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
