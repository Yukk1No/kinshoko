// Domain shapes for the prototype. Names follow GLOSSARY.md; storage is in-memory plus localStorage.

export type Namespace = '作者' | '角色' | '作品' | '一般';
export const NAMESPACES: Namespace[] = ['作者', '角色', '作品', '一般'];
/** Namespace is part of tag identity (Q90): `作者:某某` and `角色:某某` are two tags. */
export type TagKey = string;
export type TagDef = { key: TagKey; ns: Namespace; name: string; group: string | null; aliases: string[] };

export type Rating = 'general' | 'sensitive' | 'questionable' | 'explicit';
export const RATING_LABEL: Record<Rating, string> = { general: '全年龄', sensitive: '敏感', questionable: '成人（轻度）', explicit: '成人' };
/** Safe mode seals questionable and explicit out of the wall and search, and blurs them in groups and pins (Q97, Q98). */
export const isAdult = (rating: Rating) => rating === 'questionable' || rating === 'explicit';

export type SourceTag = { tag: TagKey; from: string };
export type SourceLink = { url: string; from: string };

/** 参考图: one record in one library. The same original in two libraries is two records. */
export type ReferenceImage = {
  id: string;
  libraryId: string;
  sha256: string | null;
  title: string;
  /** Stand-in for the collection time: the pixiv upload date. */
  date: string | null;
  thumb: string;
  view: string;
  w: number;
  h: number;
  viewScale: number;
  format: string;
  sourceTags: SourceTag[];
  autoTags: { tag: TagKey; score: number }[];
  autoModel: string | null;
  rating: { value: Rating; from: string };
  sourceLinks: SourceLink[];
  /** Folder membership given by the source (here: the sample organisation). */
  sourceFolders: string[];
  capturedAt?: number;
};

export type Folder = { id: string; name: string; parent: string | null };
export type Library = { id: string; name: string; folders: Folder[]; images: ReferenceImage[] };

/** Artist decisions sit beside source results and win over them (Q18, Q75–Q81). */
export type Curation = {
  tags: Record<string, Record<TagKey, 'add' | 'reject'>>;
  rating: Record<string, Rating>;
  folders: Record<string, Record<string, 'add' | 'remove'>>;
  notes: Record<string, string>;
  trashed: Record<string, number>;
  /** Tags the artist created in a library; source tags are already in the dictionary. */
  createdTags: Record<string, TagDef[]>;
};
export const emptyCuration = (): Curation => ({ tags: {}, rating: {}, folders: {}, notes: {}, trashed: {}, createdTags: {} });
export const imageKey = (image: { libraryId: string; id: string }) => `${image.libraryId}/${image.id}`;

export const AUTO_THRESHOLD = 0.35;

export type TagState = { key: TagKey; origin: 'source' | 'auto' | 'manual'; from: string; score?: number; rejected: boolean };

export function tagStates(image: ReferenceImage, curation: Curation): TagState[] {
  const decisions = curation.tags[imageKey(image)] ?? {};
  const seen = new Map<TagKey, TagState>();
  for (const t of image.sourceTags) seen.set(t.tag, { key: t.tag, origin: 'source', from: t.from, rejected: false });
  for (const t of image.autoTags) {
    if (t.score >= AUTO_THRESHOLD && !seen.has(t.tag)) seen.set(t.tag, { key: t.tag, origin: 'auto', from: image.autoModel ?? '模型', score: t.score, rejected: false });
  }
  for (const [key, decision] of Object.entries(decisions)) {
    const current = seen.get(key);
    if (decision === 'reject' && current) current.rejected = true;
    if (decision === 'add') seen.set(key, { key, origin: 'manual', from: '人工', rejected: false });
  }
  return [...seen.values()];
}

export const effectiveTags = (image: ReferenceImage, curation: Curation) =>
  tagStates(image, curation).filter((t) => !t.rejected).map((t) => t.key);

export const effectiveRating = (image: ReferenceImage, curation: Curation): Rating =>
  curation.rating[imageKey(image)] ?? image.rating.value;

export function effectiveFolders(image: ReferenceImage, curation: Curation): string[] {
  const decisions = curation.folders[imageKey(image)] ?? {};
  const set = new Set(image.sourceFolders.filter((f) => decisions[f] !== 'remove'));
  for (const [f, d] of Object.entries(decisions)) if (d === 'add') set.add(f);
  return [...set];
}

// ---------------------------------------------------------------- references on the desktop

/** Crop in original pixels; null means the whole image. */
export type Crop = { x: number; y: number; w: number; h: number };
/** 参考视图: a whole image or a fixed region, still tied to its reference image. */
export type ReferenceView = { libraryId: string; imageId: string; crop: Crop | null };

/** 截图: a picture taken outside Kinshoko or pinned from the clipboard. Memory only in the prototype. */
export type Capture = { id: string; url: string; w: number; h: number; at: number; label: string; collectedAs?: { libraryId: string; imageId: string } };

export type Rotation = 0 | 90 | 180 | 270;
/** Member-owned display state travels with a reference group (Q21, Q71). */
export type Placement = { x: number; y: number; scale: number; flipH: boolean; flipV: boolean; rotate: Rotation };
/** Desktop-only state: never saved into a group (Q71). */
export type PinDesk = { opacity: number; locked: boolean };

export type Pin = Placement & PinDesk & { id: string; source: { kind: 'view'; view: ReferenceView } | { kind: 'capture'; captureId: string } };

export type GroupMember = Placement & { view: ReferenceView };
/** 参考组: saved independently of any library and may reference several (ADR-0002). */
export type ReferenceGroup = { id: string; name: string; savedAt: number; members: GroupMember[] };

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** True while the artist is typing, so single-key shortcuts stay out of text fields. */
export const isTyping = (e: Event) => e.target instanceof Element && !!e.target.closest('input, textarea, select, [contenteditable]');
