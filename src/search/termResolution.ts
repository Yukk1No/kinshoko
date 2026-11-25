import type { Condition } from "../bindings/Condition";
import type { ContentRating } from "../bindings/ContentRating";
import type { Term } from "../bindings/Term";
import type { TermInput } from "../bindings/TermInput";

const sameRatings = (a: ContentRating[], b: ContentRating[]) => a.length === b.length && a.every((r, i) => r === b[i]);

export function inputLabel(term: TermInput) {
  return term.kind === "text" ? `“${term.text}”` : "…";
}

/** 条件树里与搜索框中这一项对应的项；点选的标签已被删除时没有。 */
export function resolvedTerm(condition: Condition, term: TermInput): Term | undefined {
  return condition.any.find((t) => {
    switch (term.kind) {
      case "tag":
        return t.kind === "tag" && t.tag.id === term.id;
      case "text":
        return t.kind === "text" && t.text === term.text;
      case "rating":
        return t.kind === "rating" && sameRatings(t.rating.ratings, [...term.ratings].sort(byRank));
      case "taggingUnfinished":
        return t.kind === "taggingUnfinished";
    }
  });
}

const RANK: ContentRating[] = ["general", "sensitive", "questionable", "explicit"];
const byRank = (a: ContentRating, b: ContentRating) => RANK.indexOf(a) - RANK.indexOf(b);
