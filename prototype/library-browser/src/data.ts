// Public artwork previews and geometric fixtures; every record below is illustrative.
export type Picture = {
  id: string; title: string; url: string; width: number; height: number;
  tags: string[]; source: string; kind: 'artwork' | 'fixture' | 'local' | 'error';
};
const samples: Omit<Picture, 'id'>[] = [
  { title: 'Jaroslava · 人像与发丝', url: '/samples/jaroslava-01.jpg', width: 960, height: 1075, tags: ['人像', '长发', '配色'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { title: '草津 · 水面与远景', url: '/samples/kusatsu.jpg', width: 960, height: 629, tags: ['风景', '配色'], source: 'Utagawa Hiroshige · 公有领域复制图', kind: 'artwork' },
  { title: 'Jaroslava · 面部明暗', url: '/samples/jaroslava-02.jpg', width: 960, height: 1192, tags: ['人像', '长发'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { title: '海岸月色 · 大色块', url: '/samples/moonlight.jpg', width: 960, height: 480, tags: ['风景', '配色'], source: 'Utagawa Hiroshige · 公有领域复制图', kind: 'artwork' },
  { title: 'Hanna · 服饰与姿态', url: '/samples/hanna.jpg', width: 960, height: 1269, tags: ['人像', '服饰'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { title: '神奈川冲浪里 · 线条', url: '/samples/wave.jpg', width: 960, height: 662, tags: ['风景', '线条', '配色'], source: 'Hokusai 原作之重刻复制图 · 公有领域', kind: 'artwork' },
  { title: '风景挂幅 · 竖向构图', url: '/samples/landscape-tall.jpg', width: 960, height: 2381, tags: ['风景', '比例测试'], source: 'Utagawa Hiroshige · 公有领域复制图', kind: 'artwork' },
  { title: 'Jaroslava · 浅色头发', url: '/samples/daughter.jpg', width: 433, height: 520, tags: ['人像', '长发'], source: 'Alphonse Mucha · 公有领域复制图', kind: 'artwork' },
  { title: '透明几何 · alpha 边缘', url: '/samples/alpha.svg', width: 480, height: 480, tags: ['透明', '比例测试'], source: '自制几何夹具 · CC0', kind: 'fixture' },
  { title: '细线网格 · 1:1 观察', url: '/samples/lines.svg', width: 720, height: 480, tags: ['线条', '比例测试'], source: '自制几何夹具 · CC0', kind: 'fixture' },
  { title: '极长比例 · 完整构图', url: '/samples/tall.svg', width: 240, height: 1440, tags: ['比例测试'], source: '自制几何夹具 · CC0', kind: 'fixture' },
  { title: '极宽比例 · 完整构图', url: '/samples/wide.svg', width: 1440, height: 240, tags: ['比例测试'], source: '自制几何夹具 · CC0', kind: 'fixture' },
  { title: '小图 · 不放大时的尺寸', url: '/samples/tiny.svg', width: 96, height: 96, tags: ['比例测试'], source: '自制几何夹具 · CC0', kind: 'fixture' },
  { title: '无法读取 · 单项失败夹具', url: 'data:image/png;base64,broken', width: 600, height: 750, tags: ['比例测试'], source: '刻意构造的坏图；可重新选择本地文件', kind: 'error' },
];
export function samplePictures(count: number): Picture[] {
  return Array.from({ length: count }, (_, index) => ({ ...samples[index % samples.length],
    id: `sample-${String(index + 1).padStart(5, '0')}`,
    title: `${samples[index % samples.length].title} · ${String(index + 1).padStart(3, '0')}`,
  }));
}
export const sampleTags = ['人像', '长发', '服饰', '风景', '线条', '配色', '透明', '比例测试'];
