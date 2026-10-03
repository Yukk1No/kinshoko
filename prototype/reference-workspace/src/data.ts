export type Picture = {
  id: string; title: string; url: string; width: number; height: number;
  tags: string[]; source: string; kind: 'artwork' | 'fixture' | 'local' | 'error';
  libraryId: string; folderIds: string[];
};
export type Library = { id: string; name: string; description: string };
export type Folder = { id: string; libraryId: string; name: string; parentId: string | null };
export type Crop = { x: number; y: number; w: number; h: number };
export type Reference = {
  id: string; imageId: string; libraryId: string; crop: Crop;
  x: number; y: number; width: number; locked: boolean;
};
export type ReferenceGroup = { id: string; name: string; members: Reference[] };
export type Query = { libraryId: string; folderId: string; descendants: boolean; text: string; tags: string[] };
export type SavedQuery = { id: string; name: string; query: Query };
export const whole: Crop = { x: 0, y: 0, w: 1, h: 1 };
let sequence = 0;
// Session IDs work on the phone's private HTTP preview too. This is not a persisted ID format.
export const nextId = (prefix: string) => `${prefix}-${++sequence}`;
export const libraries: Library[] = [
  { id: 'art', name: '创作参考', description: '8 张公开作品，用来试找图与局部取用' },
  { id: 'fixtures', name: '显示测试', description: '5 张自制样本，观察比例、细线与透明区域' },
];
export const initialFolders: Folder[] = [
  { id: 'character', libraryId: 'art', name: '角色创作', parentId: null },
  { id: 'hair', libraryId: 'art', name: '发型', parentId: 'character' },
  { id: 'clothes', libraryId: 'art', name: '服饰', parentId: 'character' },
  { id: 'composition', libraryId: 'art', name: '构图与场景', parentId: null },
  { id: 'landscape', libraryId: 'art', name: '风景', parentId: 'composition' },
  { id: 'checks', libraryId: 'fixtures', name: '画面检查', parentId: null },
  { id: 'ratio', libraryId: 'fixtures', name: '特殊比例', parentId: 'checks' },
];
export const initialPictures: Picture[] = [
  { id: 'jaro1', libraryId: 'art', folderIds: ['hair', 'clothes'], title: 'Jaroslava · 人像与发丝', url: '/samples/jaroslava-01.jpg', width: 960, height: 1075, tags: ['人像', '长发', '配色', '服饰'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { id: 'kusatsu', libraryId: 'art', folderIds: ['landscape'], title: '草津 · 水面与远景', url: '/samples/kusatsu.jpg', width: 960, height: 629, tags: ['风景', '配色'], source: 'Utagawa Hiroshige · 公有领域复制图', kind: 'artwork' },
  { id: 'jaro2', libraryId: 'art', folderIds: ['hair'], title: 'Jaroslava · 面部明暗', url: '/samples/jaroslava-02.jpg', width: 960, height: 1192, tags: ['人像', '长发'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { id: 'moon', libraryId: 'art', folderIds: ['landscape'], title: '海岸月色 · 大色块', url: '/samples/moonlight.jpg', width: 960, height: 480, tags: ['风景', '配色'], source: 'Utagawa Hiroshige · 公有领域复制图', kind: 'artwork' },
  { id: 'hanna', libraryId: 'art', folderIds: ['clothes'], title: 'Hanna · 服饰与姿态', url: '/samples/hanna.jpg', width: 960, height: 1269, tags: ['人像', '服饰'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { id: 'wave', libraryId: 'art', folderIds: ['landscape'], title: '神奈川冲浪里 · 线条', url: '/samples/wave.jpg', width: 960, height: 662, tags: ['风景', '线条', '配色'], source: 'Hokusai 原作之重刻复制图 · 公有领域', kind: 'artwork' },
  { id: 'landscape', libraryId: 'art', folderIds: ['landscape'], title: '风景挂幅 · 竖向构图', url: '/samples/landscape-tall.jpg', width: 960, height: 2381, tags: ['风景', '竖向构图'], source: 'Utagawa Hiroshige · 公有领域复制图', kind: 'artwork' },
  { id: 'daughter', libraryId: 'art', folderIds: [], title: 'Jaroslava · 浅色头发', url: '/samples/daughter.jpg', width: 433, height: 520, tags: ['人像', '长发'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { id: 'alpha', libraryId: 'fixtures', folderIds: ['checks'], title: '透明几何 · 边缘', url: '/samples/alpha.svg', width: 480, height: 480, tags: ['透明', '比例测试'], source: '自制几何样本 · CC0', kind: 'fixture' },
  { id: 'lines', libraryId: 'fixtures', folderIds: ['checks'], title: '细线网格 · 1:1 观察', url: '/samples/lines.svg', width: 720, height: 480, tags: ['线条', '比例测试'], source: '自制几何样本 · CC0', kind: 'fixture' },
  { id: 'tall', libraryId: 'fixtures', folderIds: ['ratio'], title: '极长比例 · 完整构图', url: '/samples/tall.svg', width: 240, height: 1440, tags: ['比例测试'], source: '自制几何样本 · CC0', kind: 'fixture' },
  { id: 'wide', libraryId: 'fixtures', folderIds: ['ratio'], title: '极宽比例 · 完整构图', url: '/samples/wide.svg', width: 1440, height: 240, tags: ['比例测试'], source: '自制几何样本 · CC0', kind: 'fixture' },
  { id: 'tiny', libraryId: 'fixtures', folderIds: [], title: '小图 · 96 × 96', url: '/samples/tiny.svg', width: 96, height: 96, tags: ['比例测试'], source: '自制几何样本 · CC0', kind: 'fixture' },
];
export const initialQueries: SavedQuery[] = [
  { id: 'long-hair', name: '长发人物', query: { libraryId: 'art', folderId: 'all', descendants: true, text: '', tags: ['人像', '长发'] } },
  { id: 'scenery-color', name: '场景配色', query: { libraryId: 'art', folderId: 'all', descendants: true, text: '', tags: ['风景', '配色'] } },
];
export const initialGroups: ReferenceGroup[] = [
  { id: 'portraits', name: '人物与衣褶', members: [
    { id: 'seed-face', libraryId: 'art', imageId: 'jaro1', crop: { x: .22, y: .11, w: .48, h: .4 }, x: .1, y: .12, width: .3, locked: false },
    { id: 'seed-dress', libraryId: 'art', imageId: 'hanna', crop: { x: .16, y: .49, w: .66, h: .42 }, x: .62, y: .42, width: .33, locked: false },
  ] },
  { id: 'composition-group', name: '线条与构图', members: [
    { id: 'seed-wave', libraryId: 'art', imageId: 'wave', crop: whole, x: .12, y: .15, width: .4, locked: false },
    { id: 'seed-lines', libraryId: 'fixtures', imageId: 'lines', crop: whole, x: .65, y: .57, width: .3, locked: false },
  ] },
];
export function folderBranch(id: string, folders: Folder[]): string[] {
  return [id, ...folders.filter(folder => folder.parentId === id).flatMap(folder => folderBranch(folder.id, folders))];
}
export function folderPath(id: string, folders: Folder[]): string[] {
  const folder = folders.find(item => item.id === id);
  return folder ? [...(folder.parentId ? folderPath(folder.parentId, folders) : []), folder.name] : [];
}
const aliases: Record<string, string> = { '肖像': '人像', '人物': '人像', 'portrait': '人像', 'longhair': '长发', '长头发': '长发', '衣服': '服饰', '景色': '风景' };
export function matches(picture: Picture, query: Query, folders: Folder[]): boolean {
  if (picture.libraryId !== query.libraryId) return false;
  if (query.folderId === 'unfiled' && picture.folderIds.length) return false;
  if (!['all', 'unfiled'].includes(query.folderId)) {
    const ids = query.descendants ? folderBranch(query.folderId, folders) : [query.folderId];
    if (!picture.folderIds.some(id => ids.includes(id))) return false;
  }
  if (!query.tags.every(tag => picture.tags.includes(tag))) return false;
  const haystack = [picture.title, picture.source, ...picture.tags].join(' ').toLowerCase();
  return query.text.trim().toLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(aliases[term] ?? term));
}
export const cloneMembers = (members: Reference[]) => members.map(member => ({ ...member, crop: { ...member.crop } }));
