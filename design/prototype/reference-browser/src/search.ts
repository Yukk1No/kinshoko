import type { Curation, ReferenceImage, TagDef, TagKey } from './model';
import { effectiveFolders, effectiveTags, imageKey } from './model';

/** A term is a picked tag or typed words. Typed words match every namespace (Q95, Q96). */
export type Term = { kind: 'tag'; key: TagKey } | { kind: 'text'; text: string };
/** Conditions combine with AND; alternatives inside one condition are the explicit "任一" (Q29). */
export type Condition = { id: string; any: Term[]; negate: boolean };

export type Scope = { folderId: string | null; withDescendants: boolean; trash: boolean };

const fold = (s: string) => s.normalize('NFKC').toLowerCase();

export function tagText(def: TagDef | undefined, key: TagKey) {
  return def ? [def.name, ...def.aliases] : [key.slice(key.indexOf(':') + 1)];
}

export type Indexed = { image: ReferenceImage; tags: Set<TagKey>; words: string[]; folders: string[] };

/** Precompute what each image can be found by: effective tag names and aliases, notes, links, title. */
export function indexImages(images: ReferenceImage[], dict: Record<TagKey, TagDef>, curation: Curation): Indexed[] {
  return images.map((image) => {
    const tags = new Set(effectiveTags(image, curation));
    const words = [image.title, curation.notes[imageKey(image)] ?? '', ...image.sourceLinks.map((l) => l.url)];
    for (const key of tags) words.push(...tagText(dict[key], key));
    return { image, tags, words: words.map(fold), folders: effectiveFolders(image, curation) };
  });
}

function termMatches(entry: Indexed, term: Term) {
  if (term.kind === 'tag') return entry.tags.has(term.key);
  const needle = fold(term.text.trim());
  return needle === '' || entry.words.some((w) => w.includes(needle));
}

export function descendants(folders: { id: string; parent: string | null }[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

export function runSearch(index: Indexed[], conditions: Condition[], scope: Scope, folders: { id: string; parent: string | null }[], curation: Curation) {
  const inScope = scope.folderId ? (scope.withDescendants ? descendants(folders, scope.folderId) : new Set([scope.folderId])) : null;
  return index.filter((entry) => {
    // Recoverably deleted images leave normal search (Q42) and only show in the trash.
    const trashed = imageKey(entry.image) in curation.trashed;
    if (scope.trash !== trashed) return false;
    if (inScope && !entry.folders.some((f) => inScope.has(f))) return false;
    return conditions.every((c) => c.any.some((t) => termMatches(entry, t)) !== c.negate);
  }).map((e) => e.image);
}

export type Candidate = { key: TagKey; def: TagDef; via: string | null; count: number; rank: number };

/** Tags whose name or alias contains the typed words, best first. The same word in two
 * namespaces yields two candidates; neither is chosen for the artist (Q96). */
export function candidates(query: string, dict: Record<TagKey, TagDef>, counts: Map<TagKey, number>, limit = 8): Candidate[] {
  const q = fold(query.trim());
  if (!q) return [];
  const out: Candidate[] = [];
  for (const def of Object.values(dict)) {
    const count = counts.get(def.key) ?? 0;
    let best: { rank: number; via: string | null } | null = null;
    for (const [i, word] of [def.name, ...def.aliases].entries()) {
      const w = fold(word);
      const rank = w === q ? 0 : w.startsWith(q) ? 1 : w.includes(q) ? 2 : -1;
      if (rank < 0) continue;
      const score = rank * 2 + (i === 0 ? 0 : 1);
      if (!best || score < best.rank) best = { rank: score, via: i === 0 ? null : word };
    }
    if (best && (count > 0 || def.group)) out.push({ key: def.key, def, via: best.via, count, rank: best.rank });
  }
  return out.sort((a, b) => a.rank - b.rank || b.count - a.count || a.def.name.length - b.def.name.length).slice(0, limit);
}

export function countTags(index: Indexed[]) {
  const counts = new Map<TagKey, number>();
  for (const e of index) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

export function termLabel(term: Term, dict: Record<TagKey, TagDef>) {
  if (term.kind === 'text') return `“${term.text}”`;
  const def = dict[term.key];
  if (!def) return term.key;
  return def.ns === '一般' ? def.name : `${def.ns}：${def.name}`;
}
