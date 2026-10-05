import { describe, expect, it } from 'vitest';
import { captureAnchor, masonry, resolveAnchor, visible } from './layout';
import { emptyCuration, effectiveTags, type ReferenceImage, type TagDef } from './model';
import { candidates, countTags, indexImages, runSearch, type Condition } from './search';
import { sealBookSVG } from './sealbook';

const def = (key: string, group: string | null = null, aliases: string[] = []): TagDef => {
  const [ns, name] = key.split(':');
  return { key, ns: ns as TagDef['ns'], name, group, aliases };
};
const dict = Object.fromEntries([
  def('一般:蓝发', '发色', ['青髪', '蓝头发']), def('一般:白发', '发色', ['白髪', '白毛']), def('一般:银发', '发色', ['銀髪', '白毛']),
  def('一般:齐刘海', '刘海', ['ぱっつん']), def('作品:蔚蓝档案', null, ['ブルアカ']), def('作者:某某'), def('角色:某某'),
].map((d) => [d.key, d]));

const image = (id: string, tags: string[], extra: Partial<ReferenceImage> = {}): ReferenceImage => ({
  id, libraryId: 'lib', sha256: null, title: id, date: null, thumb: '', view: '', w: 100, h: 100, viewScale: 1, format: 'PNG',
  sourceTags: tags.map((tag) => ({ tag, from: 'pixiv' })), autoTags: [], autoModel: null,
  rating: { value: 'general', from: 'pixiv' }, sourceLinks: [], sourceFolders: [], ...extra,
});
const images = [
  image('a', ['一般:蓝发', '一般:齐刘海']), image('b', ['一般:蓝发']), image('c', ['一般:白发', '作者:某某']),
  image('d', ['一般:银发', '角色:某某']), image('e', ['作品:蔚蓝档案']),
];
const all = { folderId: null, withDescendants: true, trash: false };
const ids = (conds: Condition[], curation = emptyCuration()) =>
  runSearch(indexImages(images, dict, curation), conds, all, [], curation).map((i) => i.id);
const tag = (key: string) => ({ kind: 'tag' as const, key });
const text = (t: string) => ({ kind: 'text' as const, text: t });
const cond = (any: Condition['any'], negate = false): Condition => ({ id: Math.random().toString(), any, negate });

describe('search', () => {
  it('combines conditions with AND by default (Q29)', () => {
    expect(ids([cond([tag('一般:蓝发')]), cond([tag('一般:齐刘海')])])).toEqual(['a']);
  });
  it('treats alternatives inside one condition as 任一, and negation as exclusion', () => {
    expect(ids([cond([tag('一般:白发'), tag('一般:银发')])])).toEqual(['c', 'd']);
    expect(ids([cond([tag('一般:蓝发')]), cond([tag('一般:齐刘海')], true)])).toEqual(['b']);
  });
  it('matches typed words through aliases in any language', () => {
    expect(ids([cond([text('青髪')])])).toEqual(['a', 'b']);
    expect(ids([cond([text('ブルアカ')])])).toEqual(['e']);
  });
  it('matches every namespace when an ambiguous word is not narrowed (Q95, Q96)', () => {
    expect(ids([cond([text('某某')])])).toEqual(['c', 'd']);
    expect(ids([cond([tag('作者:某某')])])).toEqual(['c']);
    // An ambiguous alias keeps both tags apart; typed, it finds both.
    expect(ids([cond([text('白毛')])])).toEqual(['c', 'd']);
  });
  it('lists one candidate per namespace for the same word', () => {
    const list = candidates('某某', dict, countTags(indexImages(images, dict, emptyCuration())));
    expect(list.map((c) => c.key).sort()).toEqual(['作者:某某', '角色:某某']);
    expect(candidates('白毛', dict, new Map()).map((c) => c.key).sort()).toEqual(['一般:白发', '一般:银发']);
  });
  it('lets manual decisions win over source tags (Q18)', () => {
    const curation = emptyCuration();
    curation.tags['lib/a'] = { '一般:蓝发': 'reject' };
    curation.tags['lib/e'] = { '一般:蓝发': 'add' };
    expect(effectiveTags(images[0], curation)).toEqual(['一般:齐刘海']);
    expect(ids([cond([tag('一般:蓝发')])], curation)).toEqual(['b', 'e']);
  });
  it('drops recoverably deleted images from normal search (Q42)', () => {
    const curation = emptyCuration();
    curation.trashed['lib/b'] = 1;
    expect(ids([cond([tag('一般:蓝发')])], curation)).toEqual(['a']);
  });
});

describe('masonry', () => {
  const items = [{ w: 100, h: 100 }, { w: 100, h: 300 }, { w: 200, h: 100 }, { w: 100, h: 900 }, { w: 100, h: 100 }, { w: 100, h: 200 }];
  const opts = { width: 640, target: 200, gap: 8, pad: 12, capRatio: null };
  it('keeps every picture at its own aspect ratio, uncropped', () => {
    const l = masonry(items, opts);
    l.boxes.forEach((b, i) => expect(b.h / b.w).toBeCloseTo(items[i].h / items[i].w, 6));
  });
  it('limits very tall pictures by scaling, not cropping', () => {
    const l = masonry(items, { ...opts, capRatio: 2.6 });
    expect(l.boxes[3].h).toBeCloseTo(l.columnWidth * 2.6, 6);
  });
  it('is a pure function of sizes and width', () => {
    expect(masonry(items, opts)).toEqual(masonry(items, opts));
  });
  it('finds exactly the intersecting boxes', () => {
    const l = masonry(Array.from({ length: 200 }, (_, i) => items[i % items.length]), opts);
    const brute = l.boxes.flatMap((b, i) => (b.y + b.h >= 500 && b.y < 900 ? [i] : []));
    expect(visible(l, 500, 900)).toEqual(brute);
  });
  it('keeps the anchored picture at the same offset after the width changes', () => {
    const many = Array.from({ length: 300 }, (_, i) => items[i % items.length]);
    const names = many.map((_, i) => `p${i}`);
    const wide = masonry(many, { ...opts, width: 1200 });
    const anchor = captureAnchor(wide, names, 3000, 800)!;
    const narrow = masonry(many, { ...opts, width: 700 });
    const top = resolveAnchor(narrow, names, anchor)!;
    const i = names.indexOf(anchor.id);
    expect(top - narrow.boxes[i].y).toBeCloseTo(3000 - wide.boxes[i].y, 6);
  });
});

describe('seal book', () => {
  const col = { ink: 'I', acc: 'A', cut: 'C' };
  it('draws the closed book with the lock when sealed and the open book with the star when open', () => {
    const sealed = sealBookSVG(0, col), open = sealBookSVG(1, col);
    expect(sealed).toContain('fill="A"');
    expect(sealed).not.toContain('rotate(');
    expect(open).not.toContain('fill="A"');
    expect(open).toContain('rotate(');
  });
  it('gives a valid drawing at every frame, so a reversal can start anywhere', () => {
    for (let p = 0; p <= 1; p += 0.01) expect(sealBookSVG(p, col)).not.toMatch(/NaN|Infinity/);
  });
});
