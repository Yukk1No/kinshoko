import { useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { Candidate } from "../bindings/Candidate";
import type { Condition } from "../bindings/Condition";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import type { SimilarTag } from "../bindings/SimilarTag";
import type { TagLabel } from "../bindings/TagLabel";
import type { Term } from "../bindings/Term";
import type { TermInput } from "../bindings/TermInput";
import { searchCandidates, setTagApprox } from "../ipc";

/** 界面语言。多语言界面随后续切片加入。 */
export const UI_LANG = "zh-CN";
const LIMIT = 8;

const NAMESPACE: Record<TagLabel["namespace"], string> = {
  general: "",
  artist: "作者：",
  character: "角色：",
  work: "作品：",
};

export const tagName = (tag: TagLabel) => `${NAMESPACE[tag.namespace]}${tag.name}`;

/** 标签名后的提示：尚未翻译（“文A”），或没有外部对应、不参与内置近似对应表。 */
export function TagMarks({ tag }: { tag: TagLabel }) {
  return (
    <>
      {tag.untranslated && (
        <span className="untranslated" title="尚未翻译 · 模型原名">
          文A
        </span>
      )}
      {!tag.hasExternal && (
        <span
          className="no-external"
          role="img"
          aria-label="没有外部对应，不参与内置近似对应表"
          title="没有外部对应，不参与内置近似对应表"
        />
      )}
    </>
  );
}

function inputLabel(term: TermInput) {
  return term.kind === "text" ? `“${term.text}”` : "…";
}

/** 文字项也匹配的标签，鼠标悬停时显示，画师能看见文字查到了什么。 */
function termTitle(term: Term) {
  if (term.kind !== "text" || term.tags.length === 0) return undefined;
  return `也匹配标签：${term.tags.map(tagName).join("、")}`;
}

/** 条件树里与搜索框中这一项对应的项；点选的标签已被删除时没有。 */
function resolvedTerm(condition: Condition, term: TermInput): Term | undefined {
  return condition.any.find((t) =>
    term.kind === "tag" ? t.kind === "tag" && t.tag.id === term.id : t.kind === "text" && t.text === term.text,
  );
}

/** 这一项只有一个标签时是它：“＋”加的相近标签以它为另一端。 */
function soleTag(term: Term): TagLabel | null {
  if (term.kind === "tag") return term.tag;
  return term.tags.length === 1 ? term.tags[0] : null;
}

type Place = { condition: number; term: number };

type Props = {
  libraryId: string;
  input: SearchInput;
  /** 当前条件的可见条件树（Search 解析结果）；还没解析好时为空。 */
  tree: ConditionTree | null;
  /** 在相近标签旁标出来源（内置／个人），设置中开启。 */
  showSource: boolean;
  onChange: (input: SearchInput) => void;
  onError: (message: string) => void;
};

/**
 * 搜索框：条件以标签块显示，各条件同时满足。打字时下拉第一行是“查找‘X’”（按文字匹配），
 * 下面按命名空间与别名列出候选标签。回车或单击加一个新条件；Alt+回车或 Ctrl 单击把它加进
 * 上一个条件，作为“任一”。标签块上可以排除或去掉条件。
 *
 * 近似查找默认开启：标签块里列出展开的相近标签。关掉一个时选“只这次”或“以后都不展开”
 * （记进个人近似对应表）；“＋”从库内标签里挑一个加为相近；“精确查找”一键不展开。
 */
export function SearchBox({ libraryId, input, tree, showSource, onChange, onError }: Props) {
  const [text, setText] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [dismissing, setDismissing] = useState<(Place & { similar: SimilarTag }) | null>(null);
  const [adding, setAdding] = useState<TagLabel | null>(null);

  useEffect(() => {
    let alive = true;
    if (!text.trim()) {
      setCandidates([]);
      return;
    }
    searchCandidates(libraryId, text, UI_LANG, LIMIT).then(
      (found) => alive && setCandidates(found),
      () => alive && setCandidates([]),
    );
    return () => { alive = false; };
  }, [libraryId, text]);

  const rows: TermInput[] = text.trim()
    ? [
        { kind: "text", text: text.trim(), dismissed: [] },
        ...candidates.map((c) => ({ kind: "tag" as const, id: c.tag.id, dismissed: [] })),
      ]
    : [];

  const change = (conditions: SearchInput["conditions"]) => onChange({ ...input, conditions });

  const add = (term: TermInput, alternative: boolean) => {
    const conditions = [...input.conditions];
    const last = conditions.at(-1);
    if (alternative && last) {
      conditions[conditions.length - 1] = { ...last, any: [...last.any, term] };
    } else {
      conditions.push({ any: [term], negate: false });
    }
    change(conditions);
    setText("");
    setActive(0);
  };

  const pick = (i: number, e: MouseEvent) => add(rows[i], e.ctrlKey || e.metaKey);

  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && rows.length) {
      e.preventDefault();
      add(rows[Math.min(active, rows.length - 1)], e.altKey);
    } else if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % rows.length);
    } else if (e.key === "ArrowUp" && rows.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + rows.length) % rows.length);
    } else if (e.key === "Escape") {
      if (text) setText("");
      else setOpen(false);
    } else if (e.key === "Backspace" && !text && input.conditions.length) {
      change(input.conditions.slice(0, -1));
    }
  };

  const toggle = (i: number) =>
    change(input.conditions.map((c, j) => (j === i ? { ...c, negate: !c.negate } : c)));
  const remove = (i: number) => change(input.conditions.filter((_, j) => j !== i));

  /** “只这次”：只在这一项里不展开这个相近标签。 */
  const dismissOnce = ({ condition, term, similar }: Place & { similar: SimilarTag }) => {
    change(
      input.conditions.map((c, i) =>
        i !== condition
          ? c
          : {
              ...c,
              any: c.any.map((t, j) =>
                j === term ? { ...t, dismissed: [...t.dismissed, similar.tag.id] } : t,
              ),
            },
      ),
    );
    setDismissing(null);
  };

  /** “以后都不展开”：每一对都记为不相近；词表变化后条件会重新解析。 */
  const dismissForever = (similar: SimilarTag) => {
    setDismissing(null);
    Promise.all(similar.of.map((id) => setTagApprox(libraryId, id, similar.tag.id, "notSimilar"))).catch((e) =>
      onError(String(e)),
    );
  };

  const addSimilar = (to: TagLabel, tag: TagLabel) => {
    setAdding(null);
    setTagApprox(libraryId, to.id, tag.id, "similar").catch((e) => onError(String(e)));
  };

  const shown = open && rows.length > 0;
  return (
    <div className="search">
      <ul className="search-chips" aria-label="查找条件">
        {input.conditions.map((c, i) => {
          const resolved: Condition | undefined = tree?.conditions[i];
          const terms = c.any.map((t, j) => ({ input: t, place: j, term: resolved && resolvedTerm(resolved, t) }));
          const visible = resolved ? terms.filter((t) => t.term) : terms;
          return (
            <li key={i} className="search-chip" data-negate={c.negate || undefined}>
              {c.negate && <span className="search-chip-not">不要</span>}
              {visible.length === 0 ? (
                <span className="search-chip-missing">已删除的标签</span>
              ) : (
                visible.map(({ input: t, place, term }, k) => (
                  <span key={place} className="search-term">
                    {k > 0 && <span className="search-chip-or"> 或 </span>}
                    {term ? (
                      <TermView
                        term={term}
                        showSource={showSource}
                        onDismiss={(similar) => setDismissing({ condition: i, term: place, similar })}
                        onAdd={(to) => setAdding(to)}
                      />
                    ) : (
                      <span>{inputLabel(t)}</span>
                    )}
                  </span>
                ))
              )}
              <button
                type="button"
                aria-label={c.negate ? "不再排除这个条件" : "排除这个条件"}
                aria-pressed={c.negate}
                onClick={() => toggle(i)}
              >
                ⊘
              </button>
              <button type="button" aria-label="去掉这个条件" onClick={() => remove(i)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <div className="search-field">
        <input
          role="combobox"
          aria-label="查找参考图"
          aria-expanded={shown}
          aria-controls="search-candidates"
          aria-activedescendant={shown ? `search-row-${active}` : undefined}
          placeholder="查找标签或文字"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={keyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        />
        {shown && (
          <ul
            id="search-candidates"
            role="listbox"
            className="search-candidates"
            // 点选时不让输入框失去焦点，下拉不会先关掉。
            onMouseDown={(e) => e.preventDefault()}
          >
            <li
              id="search-row-0"
              role="option"
              aria-selected={active === 0}
              onClick={(e) => pick(0, e)}
            >
              查找“{text.trim()}”
            </li>
            {candidates.map((c, k) => (
              <li
                key={c.tag.id}
                id={`search-row-${k + 1}`}
                role="option"
                aria-selected={active === k + 1}
                onClick={(e) => pick(k + 1, e)}
              >
                <span className="search-candidate-name">{tagName(c.tag)}</span>
                <TagMarks tag={c.tag} />
                {c.via && <span className="search-candidate-via">又名：{c.via}</span>}
                <span className="search-candidate-count">{c.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        className="search-exact"
        aria-pressed={input.exact}
        title={input.exact ? "现在只查选中的标签；再按一次展开相近标签" : "不展开相近标签，只查选中的标签"}
        onClick={() => onChange({ ...input, exact: !input.exact })}
      >
        精确查找
      </button>
      {dismissing && (
        <div className="search-popover" role="dialog" aria-label="不展开相近标签">
          <p>不展开“{tagName(dismissing.similar.tag)}”：</p>
          <button type="button" onClick={() => dismissOnce(dismissing)}>
            只这次
          </button>
          <button type="button" onClick={() => dismissForever(dismissing.similar)}>
            以后都不展开
          </button>
          <button type="button" onClick={() => setDismissing(null)}>
            取消
          </button>
        </div>
      )}
      {adding && (
        <AddSimilar libraryId={libraryId} to={adding} onPick={(tag) => addSimilar(adding, tag)} onCancel={() => setAdding(null)} />
      )}
    </div>
  );
}

/** 条件里的一项，及其展开的相近标签。 */
function TermView({
  term,
  showSource,
  onDismiss,
  onAdd,
}: {
  term: Term;
  showSource: boolean;
  onDismiss: (similar: SimilarTag) => void;
  onAdd: (to: TagLabel) => void;
}) {
  const sole = soleTag(term);
  return (
    <>
      {term.kind === "tag" ? (
        <>
          <span>{tagName(term.tag)}</span>
          <TagMarks tag={term.tag} />
        </>
      ) : (
        <span title={termTitle(term)}>“{term.text}”</span>
      )}
      {term.similar.length > 0 && (
        <span className="search-similar">
          <span className="search-chip-or">或相近：</span>
          {term.similar.map((s, k) => (
            <span key={s.tag.id} className="search-similar-tag">
              {k > 0 && "、"}
              <span>{tagName(s.tag)}</span>
              <TagMarks tag={s.tag} />
              {showSource && (
                <span className="search-similar-source">{s.source === "builtin" ? "内置" : "个人"}</span>
              )}
              <button type="button" aria-label={`不展开“${tagName(s.tag)}”`} onClick={() => onDismiss(s)}>
                ×
              </button>
            </span>
          ))}
        </span>
      )}
      {sole && (
        <button type="button" aria-label={`给“${tagName(sole)}”加相近标签`} onClick={() => onAdd(sole)}>
          ＋
        </button>
      )}
    </>
  );
}

/** “＋”：按名称或别名从库内标签里挑一个，加为 `to` 的相近标签。 */
function AddSimilar({
  libraryId,
  to,
  onPick,
  onCancel,
}: {
  libraryId: string;
  to: TagLabel;
  onPick: (tag: TagLabel) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Candidate[]>([]);

  useEffect(() => {
    let alive = true;
    if (!text.trim()) {
      setFound([]);
      return;
    }
    searchCandidates(libraryId, text, UI_LANG, LIMIT).then(
      (list) => alive && setFound(list.filter((c) => c.tag.id !== to.id)),
      () => alive && setFound([]),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, text, to.id]);

  return (
    <div className="search-popover" role="dialog" aria-label="加相近标签">
      <p>查“{tagName(to)}”时也找：</p>
      <input
        role="combobox"
        aria-label="挑一个库内标签"
        aria-expanded={found.length > 0}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && found.length) onPick(found[0].tag);
        }}
      />
      {found.length > 0 && (
        <ul role="listbox" className="search-popover-list">
          {found.map((c) => (
            <li key={c.tag.id} role="option" aria-selected={false} onClick={() => onPick(c.tag)}>
              <span>{tagName(c.tag)}</span>
              <TagMarks tag={c.tag} />
              {c.via && <span className="search-candidate-via">又名：{c.via}</span>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
