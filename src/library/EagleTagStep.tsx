import { useEffect, useState } from "react";
import type { EagleTagMapping } from "../bindings/EagleTagMapping";
import type { MappedExternal } from "../bindings/MappedExternal";
import type { UnmatchedEagleTag } from "../bindings/UnmatchedEagleTag";
import { eagleTagMapping, externalSuggestions, mapTagExternal } from "../ipc";
import { TagMarks, tagName, UI_LANG } from "../search/SearchBox";

const SUGGESTIONS = 8;

type Props = {
  libraryId: string;
  onClose: () => void;
};

type Done = { name: string; mapped: MappedExternal };

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
  onError: (message: string) => void;
}) {
  const name = tagName(item.tag);
  const [draft, setDraft] = useState(item.candidates[0] ?? "");
  const [suggestions, setSuggestions] = useState<string[]>(item.candidates);
  const [busy, setBusy] = useState(false);
  const listId = `external-${item.tag.id}`;

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
  const submit = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      onMapped(await mapTagExternal(libraryId, item.tag.id, draft.trim()));
    } catch (error) {
      onError(`无法给 ${name} 补上外部对应：${String(error)}`);
      setBusy(false);
    }
  };

  return (
    <li>
      <span>
        {name}
        <TagMarks tag={item.tag} /> · {item.count} 张
      </span>
      {item.candidates.length > 1 && <span className="import-report-reason">对上了多个外部名称，请选一个</span>}
      {item.takenExternal && (
        <span className="import-report-reason">
          {item.takenExternal} 已对应到{item.takenBy ? ` ${tagName(item.takenBy)}` : "另一个标签"}
        </span>
      )}
      <input
        list={listId}
        aria-label={`${name} 的外部对应`}
        placeholder="外部名称，如 blue_eyes"
        value={draft}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <button type="button" aria-label={`补上 ${name} 的外部对应`} disabled={busy || !draft.trim()} onClick={() => void submit()}>
        补上
      </button>
      <button type="button" aria-label={`跳过 ${name}`} disabled={busy} onClick={onSkip}>
        跳过
      </button>
    </li>
  );
}

/**
 * 迁入向导“标签的外部对应”：Eagle 标签迁入后按名称与翻译表自动匹配外部对应，列出没对上的，
 * 画师可以逐个补上或跳过。跳过的标签早已照常迁入，只是不参与内置近似对应表。
 */
export function EagleTagStep({ libraryId, onClose }: Props) {
  const [mapping, setMapping] = useState<EagleTagMapping | null>(null);
  const [remaining, setRemaining] = useState<UnmatchedEagleTag[]>([]);
  const [done, setDone] = useState<Done[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    eagleTagMapping(libraryId, UI_LANG).then(
      (value) => {
        if (!alive) return;
        setMapping(value);
        setRemaining(value.unmatched);
      },
      (e) => alive && setError(`无法匹配标签的外部对应：${String(e)}`),
    );
    return () => {
      alive = false;
    };
  }, [libraryId]);

  const drop = (id: string) => setRemaining((rows) => rows.filter((r) => r.tag.id !== id));

  return (
    <section className="import-report eagle-tag-step" aria-label="标签的外部对应">
      <header>
        <span>
          标签的外部对应
          {mapping && `：已自动对上 ${mapping.matched.length} 个标签，${remaining.length} 个没对上`}
        </span>
        <button type="button" onClick={onClose}>
          {remaining.length ? "全部跳过" : "完成"}
        </button>
      </header>
      <p>
        外部对应是标签在打标模型与内置近似对应表中的名称。没有外部对应的标签（标有
        <span className="no-external" role="img" aria-label="没有外部对应的提示图标" />
        ）照常迁入、照常可查，只是不参与内置近似对应表：查找它时不会自动带上相近的标签。可以现在补上，也可以跳过。
      </p>
      {mapping && mapping.vocabularySize === 0 && (
        <p>本机还没有可用的外部词表（打标模型尚未就绪），只能手动补上外部对应。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {done.length > 0 && (
        <ul aria-label="已补上的外部对应">
          {done.map((d) => (
            <li key={d.name}>
              <span>
                {d.name} → {d.mapped.external}
              </span>
              {!d.mapped.known && (
                <span className="import-report-reason">词表中没有这个名称，内置近似对应表多半不认识它</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {remaining.length > 0 && (
        <ul aria-label="没对上外部对应的标签">
          {remaining.map((item) => (
            <UnmatchedRow
              key={item.tag.id}
              item={item}
              libraryId={libraryId}
              onError={setError}
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
