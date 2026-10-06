import { useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { Candidate } from "../bindings/Candidate";
import type { Condition } from "../bindings/Condition";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import type { TagLabel } from "../bindings/TagLabel";
import type { Term } from "../bindings/Term";
import type { TermInput } from "../bindings/TermInput";
import { searchCandidates } from "../ipc";

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

function termLabel(term: Term) {
  return term.kind === "tag" ? tagName(term.tag) : `“${term.text}”`;
}

function inputLabel(term: TermInput) {
  return term.kind === "text" ? `“${term.text}”` : "…";
}

/** 文字项也匹配的标签，鼠标悬停时显示，画师能看见文字查到了什么。 */
function termTitle(term: Term) {
  if (term.kind !== "text" || term.tags.length === 0) return undefined;
  return `也匹配标签：${term.tags.map(tagName).join("、")}`;
}

type Props = {
  libraryId: string;
  input: SearchInput;
  /** 当前条件的可见条件树（Search 解析结果）；还没解析好时为空。 */
  tree: ConditionTree | null;
  onChange: (input: SearchInput) => void;
};

/**
 * 搜索框：条件以标签块显示，各条件同时满足。打字时下拉第一行是“查找‘X’”（按文字匹配），
 * 下面按命名空间与别名列出候选标签。回车或单击加一个新条件；Alt+回车或 Ctrl 单击把它加进
 * 上一个条件，作为“任一”。标签块上可以排除或去掉条件。
 */
export function SearchBox({ libraryId, input, tree, onChange }: Props) {
  const [text, setText] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

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
    ? [{ kind: "text", text: text.trim() }, ...candidates.map((c) => ({ kind: "tag" as const, id: c.tag.id }))]
    : [];

  const add = (term: TermInput, alternative: boolean) => {
    const conditions = [...input.conditions];
    const last = conditions.at(-1);
    if (alternative && last) {
      conditions[conditions.length - 1] = { ...last, any: [...last.any, term] };
    } else {
      conditions.push({ any: [term], negate: false });
    }
    onChange({ conditions });
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
      onChange({ conditions: input.conditions.slice(0, -1) });
    }
  };

  const toggle = (i: number) =>
    onChange({
      conditions: input.conditions.map((c, j) => (j === i ? { ...c, negate: !c.negate } : c)),
    });
  const remove = (i: number) => onChange({ conditions: input.conditions.filter((_, j) => j !== i) });

  const shown = open && rows.length > 0;
  return (
    <div className="search">
      <ul className="search-chips" aria-label="查找条件">
        {input.conditions.map((c, i) => {
          const resolved: Condition | undefined = tree?.conditions[i];
          const labels = resolved
            ? resolved.any.map((t) => ({ label: termLabel(t), title: termTitle(t) }))
            : c.any.map((t) => ({ label: inputLabel(t), title: undefined }));
          return (
            <li key={i} className="search-chip" data-negate={c.negate || undefined}>
              {c.negate && <span className="search-chip-not">不要</span>}
              {labels.length === 0 ? (
                <span className="search-chip-missing">已删除的标签</span>
              ) : (
                labels.map((l, j) => (
                  <span key={j}>
                    {j > 0 && <span className="search-chip-or"> 或 </span>}
                    <span title={l.title}>{l.label}</span>
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
                {c.tag.untranslated && (
                  <span className="untranslated" title="尚未翻译 · 模型原名">
                    文A
                  </span>
                )}
                {c.via && <span className="search-candidate-via">又名：{c.via}</span>}
                <span className="search-candidate-count">{c.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
