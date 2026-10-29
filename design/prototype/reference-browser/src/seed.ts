import raw from 'virtual:library';
import type { Folder, Library, ReferenceImage, TagDef, TagKey } from './model';

type RawImage = Omit<ReferenceImage, 'libraryId' | 'sourceFolders'> & { coverage: string[]; split: string };
type RawLibrary = { missing?: boolean; images: RawImage[]; tags: Record<TagKey, Omit<TagDef, 'key'>>; hasPredictions?: boolean; skipped?: string[] };
const data = raw as RawLibrary;

export const seedInfo = {
  missing: Boolean(data.missing) || data.images.filter((i) => i.split !== 'fixture').length === 0,
  hasPredictions: Boolean(data.hasPredictions),
  skipped: data.skipped?.length ?? 0,
};

export const dictionary: Record<TagKey, TagDef> = Object.fromEntries(
  Object.entries(data.tags).map(([key, def]) => [key, { ...def, key }]),
);

// Display groups for the quick picker. 标签分组 only affects display, never search (glossary).
export const TAG_GROUPS = ['发色', '瞳色', '发型', '发长', '画面'];

const has = (img: RawImage, ...keys: string[]) => img.sourceTags.some((t) => keys.includes(t.tag));
const works = ['原神', '绝区零', '蔚蓝档案', 'Fate/Grand Order', '明日方舟', '明日方舟：终末地', '碧蓝航线', '鸣潮', '胜利女神：妮姬', '崩坏：星穹铁道', 'hololive', 'VOCALOID'];

/** The sample organisation an artist might have brought over from Eagle. It is constructed,
 * not imported: folders are the artist's places and one picture may sit in several (Q74, Q78). */
function libraryA(images: RawImage[]): Library {
  const folders: Folder[] = [
    { id: 'a-fan', name: '同人', parent: null },
    ...works.map((w) => ({ id: `a-fan-${w}`, name: w, parent: 'a-fan' })),
    { id: 'a-original', name: '原创角色', parent: null },
    { id: 'a-hair', name: '发型收集', parent: null },
    { id: 'a-hair-twin', name: '双马尾', parent: 'a-hair' },
    { id: 'a-hair-bangs', name: '刘海', parent: 'a-hair' },
    { id: 'a-hair-short', name: '短发与波波头', parent: 'a-hair' },
    { id: 'a-paint', name: '画法', parent: null },
    { id: 'a-paint-thick', name: '厚涂', parent: 'a-paint' },
    { id: 'a-paint-light', name: '光影', parent: 'a-paint' },
    { id: 'a-paint-line', name: '线稿与黑白', parent: 'a-paint' },
    { id: 'a-pose', name: '全身与多人', parent: null },
  ];
  const out = images.filter((i) => i.split !== 'fixture').map((img): ReferenceImage => {
    const f: string[] = [];
    for (const w of works) if (has(img, `作品:${w}`)) f.push(`a-fan-${w}`);
    if (has(img, '一般:原创')) f.push('a-original');
    if (has(img, '一般:双马尾')) f.push('a-hair-twin');
    if (has(img, '一般:齐刘海', '一般:姬发式', '一般:中分')) f.push('a-hair-bangs');
    if (has(img, '一般:短发', '一般:波波头')) f.push('a-hair-short');
    if (has(img, '一般:厚涂')) f.push('a-paint-thick');
    if (has(img, '一般:逆光')) f.push('a-paint-light');
    if (has(img, '一般:线稿', '一般:黑白')) f.push('a-paint-line');
    if (has(img, '一般:全身', '一般:多人')) f.push('a-pose');
    const { coverage: _c, split: _s, ...rest } = img;
    return { ...rest, libraryId: 'lib-a', sourceFolders: f };
  });
  return { id: 'lib-a', name: '角色参考', folders: folders.filter((x) => x.parent === null || out.some((i) => i.sourceFolders.includes(x.id))), images: out };
}

/** A second library holding some of the same originals: a reference group can draw on both (ADR-0002). */
function libraryB(images: RawImage[]): Library {
  const folders: Folder[] = [
    { id: 'b-line', name: '线稿', parent: null },
    { id: 'b-thick', name: '厚涂', parent: null },
    { id: 'b-howto', name: '教程', parent: null },
    { id: 'b-test', name: '显示测试', parent: null },
  ];
  const out: ReferenceImage[] = [];
  for (const img of images) {
    const f: string[] = [];
    if (img.split === 'fixture') f.push('b-test');
    if (has(img, '一般:线稿', '一般:黑白')) f.push('b-line');
    if (has(img, '一般:厚涂')) f.push('b-thick');
    if (has(img, '一般:教程')) f.push('b-howto');
    if (!f.length) continue;
    const { coverage: _c, split: _s, ...rest } = img;
    out.push({ ...rest, libraryId: 'lib-b', sourceFolders: f });
  }
  return { id: 'lib-b', name: '画法练习', folders, images: out };
}

// Newest first, like a library sorted by collection time. Fixtures go last.
const ordered = [...data.images].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

export function seedLibraries(): Library[] {
  return [libraryA(ordered), libraryB(ordered)];
}

/** Repeats the samples to exercise layout and DOM size only. Not a performance claim. */
export function inflate(library: Library, total: number): Library {
  if (library.images.length >= total || !library.images.length) return library;
  const images: ReferenceImage[] = [];
  for (let i = 0; images.length < total; i++) {
    for (const img of library.images) {
      if (images.length >= total) break;
      images.push(i === 0 ? img : { ...img, id: `${img.id}~${i}`, title: `${img.title} · 构造 ${i}` });
    }
  }
  return { ...library, images };
}
