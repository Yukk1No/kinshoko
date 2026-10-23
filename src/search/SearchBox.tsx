import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { Candidate } from "../bindings/Candidate";
import type { Condition } from "../bindings/Condition";
import type { ContentRating } from "../bindings/ContentRating";
import type { RatingCandidate } from "../bindings/RatingCandidate";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import type { SimilarTag } from "../bindings/SimilarTag";
import type { TagLabel } from "../bindings/TagLabel";
import type { Term } from "../bindings/Term";
import type { TermInput } from "../bindings/TermInput";
import { Popover } from "@base-ui/react/popover";
import { Search } from "lucide-react";
import { Combobox, Highlight, type ComboboxOption } from "../ui/Combobox";
import { ExactToggle } from "./ExactToggle";
import { tagOption } from "./tagOptions";
import { chipsThatFit } from "./fitChips";
import { RatingName, tagName } from "./tagLabel";
import { TermView } from "./TermView";
import { ratingCandidates, searchCandidates, workspaceCandidates, workspaceSourceCandidates, setTagApprox, editSharedApprox } from "../ipc";

export { TagMarks, tagName, UNTRANSLATED_HINT } from "./tagLabel";

/** 界面语言。多语言界面随后续切片加入。 */
export const UI_LANG = "zh-CN";
export const LIMIT = 8;

/**
 * 候选的身份（#76）：资料库、浏览视角（安全模式）、词表代次与输入的文字。候选只在身份与
 * 当前相同时显示；切换安全模式、词表变化或换了资料库后，旧候选这一帧就不再显示，迟到的
 * 响应也写不回来。后端按同一视角核对（`LensChanged`）。
 */
export type Lens = { libraryId: string; safe: boolean; generation: number; workspace?: boolean; sourceTarget?: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget };
type Found = { key: string; list: Candidate[] };
const lensKey = (lens: Lens, text: string) => JSON.stringify([lens.libraryId, lens.safe, lens.generation, lens.workspace, lens.sourceTarget, text]);

/** 按 `lens` 与 `text` 取得候选；身份变了的旧结果不返回。标签整理面板挑标签时也用它。 */
export function useCandidates(lens: Lens, text: string, keep: (c: Candidate) => boolean = () => true): Candidate[] {
  return useCandidateState(lens, text, keep).list;
}

/**
 * 同 `useCandidates`，另外给出这段文字的候选是否已经取到（`ready`），没取到时不说“没有匹配”。
 * `limit`：最多取几个；调用方之后还要去掉一些（例如已经有的标签）时多取几个补上。
 */
export function useCandidateState(lens: Lens, text: string, keep: (c: Candidate) => boolean = () => true, limit = LIMIT): { list: Candidate[]; ready: boolean } {
  const [found, setFound] = useState<Found>({ key: "", list: [] });
  const key = lensKey(lens, text) + `#${limit}`;
  const { libraryId, safe } = lens;
  const keepRef = useRef(keep);
  keepRef.current = keep;
  useEffect(() => {
    let alive = true;
    if (!text.trim()) return;
    (lens.sourceTarget ? workspaceSourceCandidates(lens.sourceTarget, text, UI_LANG, safe) : lens.workspace ? workspaceCandidates(text, UI_LANG, limit, safe) : searchCandidates(libraryId, text, UI_LANG, limit, safe)).then(
      (list) => alive && setFound({ key, list: list.filter((c) => keepRef.current(c)) }),
      () => alive && setFound({ key, list: [] }),
    );
    return () => {
      alive = false;
    };
  }, [key, libraryId, safe, text, limit]);
  const ready = found.key === key && !!text.trim();
  return { list: ready ? found.list : [], ready };
}

type FoundRatings = { key: string; list: RatingCandidate[] };

/** 按 `lens` 与 `text` 取得分级候选（#161）；身份变了的旧结果不返回，安全模式切换的这一刻同样作废。 */
function useRatingCandidates(lens: Lens, text: string): RatingCandidate[] {
  const [found, setFound] = useState<FoundRatings>({ key: "", list: [] });
  const key = lensKey(lens, text);
  const { safe } = lens;
  useEffect(() => {
    let alive = true;
    if (!text.trim()) return;
    ratingCandidates(text, safe).then(
      (list) => alive && setFound({ key, list }),
      () => alive && setFound({ key, list: [] }),
    );
    return () => {
      alive = false;
    };
  }, [key, safe, text]);
  return found.key === key && text.trim() ? found.list : [];
}

const sameRatings = (a: ContentRating[], b: ContentRating[]) => a.length === b.length && a.every((r, i) => r === b[i]);

function inputLabel(term: TermInput) {
  return term.kind === "text" ? `“${term.text}”` : "…";
}

/** 条件树里与搜索框中这一项对应的项；点选的标签已被删除时没有。 */
function resolvedTerm(condition: Condition, term: TermInput): Term | undefined {
  return condition.any.find((t) => {
    switch (term.kind) {
      case "tag":
        return t.kind === "tag" && t.tag.id === term.id;
      case "text":
        return t.kind === "text" && t.text === term.text;
      case "rating":
        return t.kind === "rating" && sameRatings(t.rating.ratings, [...term.ratings].sort(byRank));
    }
  });
}

const RANK: ContentRating[] = ["general", "sensitive", "questionable", "explicit"];
const byRank = (a: ContentRating, b: ContentRating) => RANK.indexOf(a) - RANK.indexOf(b);

type Place = { condition: number; term: number };

type Props = {
  workspace?: boolean;
  libraryId: string;
  /** 浏览视角：安全模式是否开启（界面当前的状态，切换的这一刻就变）。 */
  safe: boolean;
  /** 词表代次：词表、图片或安全模式变化时递增，候选随之重新取得。 */
  generation: number;
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
 * 下面是匹配的内容分级（标明“分级”，#161），再按命名空间与别名列出候选标签。回车或单击加
 * 一个新条件；Alt+回车或 Ctrl 单击把它加进上一个条件，作为“任一”。标签块上可以排除或去掉条件。
 *
 * 近似查找默认开启：标签块里列出展开的相近标签。关掉一个时选“只这次”或“以后都不展开”
 * （记进个人近似对应表）；“＋”从可见标签里挑一个加为相近；“精确查找”一键不展开。
 */
export function SearchBox({ libraryId, safe, generation, input, tree, showSource, onChange, onError, workspace = false }: Props) {
  const [text, setText] = useState("");
  const [dismissing, setDismissing] = useState<(Place & { similar: SimilarTag; lens: string }) | null>(null);
  const [adding, setAdding] = useState<{ tag: TagLabel; lens: string } | null>(null);
  const lens: Lens = { libraryId, safe, generation, workspace };
  const candidates = useCandidates(lens, text);
  const ratings = useRatingCandidates(lens, text);
  const context = lensKey(lens, "");
  const dismissingNow = dismissing?.lens === context ? dismissing : null;
  const addingNow = adding?.lens === context ? adding.tag : null;
  useEffect(() => { setDismissing(null); setAdding(null); }, [context]);

  // 放不下的条件标签收进“+n”（#222）：每次绘制后和查找框变宽变窄时量一次，个数变了才重绘。
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [fit, setFit] = useState(Infinity);
  const measure = useRef(() => {});
  measure.current = () => setFit(chipsThatFit(root.current));
  useLayoutEffect(() => measure.current());
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined" || !root.current) return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  // 第一行“查找‘X’”按文字匹配，下面是匹配的内容分级，再是候选标签。
  const query = text.trim();
  const rows: (ComboboxOption & { term: TermInput })[] = query
    ? [
        { id: "text", icon: <Search size={14} />, label: `查找“${query}”`, term: { kind: "text", text: query, dismissed: [] } },
        ...ratings.map((r) => ({
          id: `rating-${r.rating.ratings.join("-")}`, label: <RatingName rating={r.rating} />,
          via: r.via ? <>又名 <Highlight text={r.via} query={query} /></> : undefined,
          term: { kind: "rating" as const, ratings: r.rating.ratings },
        })),
        ...candidates.map((c) => ({ ...tagOption(c, query), term: { kind: "tag" as const, id: c.tag.id, dismissed: [] } })),
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
  };

  // 回车加 Alt、单击加 Ctrl：加进上一个条件，作为“任一”。
  const pick = (row: (typeof rows)[number], e: KeyboardEvent | MouseEvent) =>
    add(row.term, e.type === "keydown" ? e.altKey : e.ctrlKey || e.metaKey);

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
                j === term && t.kind !== "rating" ? { ...t, dismissed: [...t.dismissed, similar.tag.id] } : t,
              ),
            },
      ),
    );
    setDismissing(null);
  };

  /** “以后都不展开”：每一对都记为不相近；词表变化后条件会重新解析。 */
  const dismissForever = (similar: SimilarTag) => {
    setDismissing(null);
    (workspace ? editSharedApprox({ kind: "set", rules: similar.of.map((id) => ({ a: id, b: similar.tag.id, relation: "notSimilar" })) }, safe) : Promise.all(similar.of.map((id) => setTagApprox(libraryId, id, similar.tag.id, "notSimilar")))).catch((e) =>
      onError(String(e)),
    );
  };

  const addSimilar = (to: TagLabel, tag: TagLabel) => {
    setAdding(null);
    (workspace ? editSharedApprox({ kind: "set", rules: [{ a: to.id, b: tag.id, relation: "similar" }] }, safe) : setTagApprox(libraryId, to.id, tag.id, "similar")).catch((e) => onError(String(e)));
  };

  /**
   * 一个条件的标签块；收起的标签块（`collapsed`）只占位量宽度，看不见也点不到。
   * `last`：“+n”浮层里仅剩的一个，去掉后浮层随之消失，焦点交回输入框。
   */
  const chip = (c: SearchInput["conditions"][number], i: number, collapsed = false, last = false) => {
    const resolved: Condition | undefined = tree?.conditions[i];
    const terms = c.any.map((t, j) => ({ input: t, place: j, term: resolved && resolvedTerm(resolved, t) }));
    const visible = resolved ? terms.filter((t) => t.term) : terms;
    return (
      <li key={i} className="search-chip" data-negate={c.negate || undefined} data-collapsed={collapsed || undefined} aria-hidden={collapsed || undefined} inert={collapsed || undefined}>
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
                  onDismiss={(similar) => setDismissing({ condition: i, term: place, similar, lens: context })}
                  onAdd={(to) => setAdding({ tag: to, lens: context })}
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
        <button type="button" aria-label="去掉这个条件" onClick={() => { remove(i); if (last) field.current?.focus(); }}>
          ×
        </button>
      </li>
    );
  };

  const hiddenCount = Math.max(input.conditions.length - fit, 0);
  return (
    <div className="search" ref={root}>
      <ul className="search-chips" aria-label="查找条件">
        {hiddenCount > 0 && (
          <li className="search-more">
            <Popover.Root>
              <Popover.Trigger className="search-more-btn" aria-label={`还有 ${hiddenCount} 个条件`}>+{hiddenCount}</Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={8}>
                  <Popover.Popup className="k-popup search-more-pop" aria-label="收起的查找条件">
                    <ul className="search-chips">{input.conditions.slice(0, hiddenCount).map((c, i) => chip(c, i, false, hiddenCount === 1))}</ul>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </li>
        )}
        {input.conditions.map((c, i) => chip(c, i, i < hiddenCount))}
      </ul>
      <div className="search-field">
        <Combobox
          bare
          anchor={root}
          inputRef={field}
          label="查找参考图"
          placeholder="查找标签或文字"
          value={text}
          options={rows}
          onValueChange={setText}
          onSelect={pick}
          onBackspaceEmpty={() => input.conditions.length && change(input.conditions.slice(0, -1))}
          // Esc 先清掉打了一半的字，再按一次收起。
          onKeyDown={(e) => { if (e.key === "Escape" && text) { e.preventDefault(); setText(""); } }}
        />
      </div>
      <ExactToggle exact={input.exact} onChange={(exact) => onChange({ ...input, exact })} />
      {dismissingNow && (
        <div className="search-popover" role="dialog" aria-label="不展开相近标签">
          <p>不展开“{tagName(dismissingNow.similar.tag)}”：</p>
          <button type="button" onClick={() => dismissOnce(dismissingNow)}>
            只这次
          </button>
          <button type="button" onClick={() => dismissForever(dismissingNow.similar)}>
            以后都不展开
          </button>
          <button type="button" onClick={() => setDismissing(null)}>
            取消
          </button>
        </div>
      )}
      {addingNow && (
        <AddSimilar key={addingNow.id} lens={lens} to={addingNow} onPick={(tag) => addSimilar(addingNow, tag)} onCancel={() => setAdding(null)} />
      )}
    </div>
  );
}
/** “＋”：按名称或别名从可见标签里挑一个，加为 `to` 的相近标签。 */
function AddSimilar({
  lens,
  to,
  onPick,
  onCancel,
}: {
  lens: Lens;
  to: TagLabel;
  onPick: (tag: TagLabel) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const { list: found, ready } = useCandidateState(lens, text, (c) => c.tag.id !== to.id);

  return (
    <div className="search-popover" role="dialog" aria-label="加相近标签">
      <p>查“{tagName(to)}”时也找：</p>
      <Combobox
        label={lens.workspace ? "挑一个统一标签" : "挑一个库内标签"}
        autoFocus
        value={text}
        options={found.map((c) => tagOption(c, text))}
        empty={ready && found.length === 0 ? "没有匹配的标签" : undefined}
        onValueChange={setText}
        onSelect={(option) => onPick(option.tag)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      />
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
