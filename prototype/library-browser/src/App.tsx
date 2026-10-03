// Three throwaway browser layouts on /prototype/library-browser?variant=A|B|C.
// No production library, native desktop window, tagger, persistence, or recovery is implemented.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, FolderOpen, Grid2X2, ImagePlus, Images, Library, Moon, PanelRightClose, Search, Settings2, SlidersHorizontal, Sun, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Masonry from './Masonry';
import type { Anchor, GridHandle, GridState } from './Masonry';
import Viewer from './Viewer';
import { samplePictures, sampleTags } from './data';
import type { Picture } from './data';

type Variant = 'A' | 'B' | 'C';
type Collection = 'samples' | 'local' | 'empty';
const noPictures: Picture[] = [];
const variantNames = { A: '全窗图片墙', B: '筛选优先', C: '观察优先' };
const readVariant = (): Variant => {
  const value = new URLSearchParams(location.search).get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
};
function NavButton({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-button ${active ? 'is-active' : ''}`} aria-label={label} aria-current={active ? 'page' : undefined} onClick={onClick}>
    <Icon size={22} strokeWidth={1.75} /><span className="nav-tooltip">{label}</span>
  </button>;
}
function PrototypeSwitcher({ variant, onChange }: { variant: Variant; onChange: (value: Variant) => void }) {
  const move = (direction: number) => {
    const variants: Variant[] = ['A', 'B', 'C'];
    onChange(variants[(variants.indexOf(variant) + direction + 3) % 3]);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The body shortcut never steals search/editing, gallery or viewer keys.
      if (!(event.target instanceof HTMLElement) || (event.target !== document.body && !event.target.closest('.prototype-switcher'))) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant, onChange]);
  return <div className="prototype-switcher" aria-label="样稿结构切换">
    <span className="prototype-label">交互样稿</span>
    <button onClick={() => move(-1)} aria-label="上一种结构"><ChevronLeft size={17} /></button>
    <span className="variant-name">{variant} · {variantNames[variant]}</span>
    <button onClick={() => move(1)} aria-label="下一种结构"><ChevronRight size={17} /></button>
    <span className="switcher-keys">← →</span>
  </div>;
}

export default function App() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [variant, setVariant] = useState<Variant>(readVariant);
  const [collection, setCollection] = useState<Collection>('samples');
  const [sampleCount, setSampleCount] = useState(100);
  const [localPictures, setLocalPictures] = useState<Picture[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSort] = useState('original');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [drawer, setDrawer] = useState<'library' | 'settings' | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [density, setDensity] = useState(220);
  const [uniform, setUniform] = useState(false);
  const [capTall, setCapTall] = useState(true);
  const [showState, setShowState] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [gridState, setGridState] = useState<GridState>({ columns: 0, mounted: 0, scroll: 0, width: 0 });
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<GridHandle>(null);
  const anchors = useRef<Partial<Record<Variant, Anchor>>>({});
  const browseAnchor = useRef<Anchor | undefined>(undefined);
  const objectUrls = useRef<Set<string>>(new Set());
  const samples = useMemo(() => samplePictures(sampleCount), [sampleCount]);
  const originals = collection === 'samples' ? samples : collection === 'local' ? localPictures : noPictures;
  const pictures = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const filtered = originals.filter((picture) => !hiddenIds.has(picture.id) && tags.every((tag) => picture.tags.includes(tag)) &&
      words.every((word) => `${picture.title} ${picture.tags.join(' ')}`.toLocaleLowerCase().includes(word)));
    return sort === 'name' ? [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')) : sort === 'reverse' ? [...filtered].reverse() : filtered;
  }, [originals, hiddenIds, tags, query, sort]);
  const selected = pictures.find((picture) => picture.id === selectedId);
  const aOverlay = viewerOpen && variant === 'A';
  const bOverlay = variant === 'B' && narrow && !!selected;
  const modalActive = aOverlay || bOverlay;
  const libraryName = collection === 'samples' ? '绘画观察样本' : collection === 'local' ? '本地试排' : '空白资料库';
  useEffect(() => {
    if (pictures.length && !pictures.some((picture) => picture.id === focusedId)) setFocusedId(pictures[0]?.id ?? null);
  }, [pictures, focusedId]);
  useEffect(() => {
    const handleHistory = () => setVariant(readVariant());
    window.addEventListener('popstate', handleHistory);
    return () => { window.removeEventListener('popstate', handleHistory); for (const url of objectUrls.current) URL.revokeObjectURL(url); };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const changeVariant = (next: Variant) => {
    const anchor = gridRef.current?.capture();
    // The replacement Masonry instance inherits the current reference context.
    // Public capture also retains the last meaningful anchor during empty results.
    anchors.current[variant] = anchor;
    anchors.current[next] = anchor;
    if (anchor) browseAnchor.current = anchor;
    setVariant(next); setViewerOpen(false);
    const url = new URL(location.href); url.searchParams.set('variant', next);
    history.replaceState(null, '', url);
  };
  const chooseCollection = (next: Collection) => {
    setCollection(next); setQuery(''); setTags([]); setHiddenIds(new Set()); setSelectedId(null); setFocusedId(null); setViewerOpen(false); anchors.current = {}; setDrawer(null);
  };
  const openPicture = (picture: Picture) => {
    browseAnchor.current = gridRef.current?.capture();
    setSelectedId(picture.id); setFocusedId(picture.id); setDrawer(null);
    if (variant === 'A') setViewerOpen(true);
  };
  const closeViewer = () => {
    if (!viewerOpen) return;
    setViewerOpen(false);
    gridRef.current?.restore(browseAnchor.current, focusedId ?? undefined);
  };
  const closeDetail = () => {
    if (!selected) return;
    const anchor = bOverlay ? browseAnchor.current : gridRef.current?.capture();
    const focusId = selected.id;
    setSelectedId(null);
    gridRef.current?.restore(anchor, focusId);
  };
  const selectPicture = (picture: Picture) => {
    if (variant === 'B') browseAnchor.current = gridRef.current?.capture();
    setSelectedId(picture.id); setFocusedId(picture.id);
    if (variant === 'B' && narrow) setDrawer(null);
  };
  const removePicture = (id: string) => {
    const restoreKeyboardFocus = document.activeElement instanceof HTMLElement && !!document.activeElement.closest('[data-picture-id]');
    const index = pictures.findIndex((picture) => picture.id === id);
    const next = pictures[index + 1] ?? pictures[index - 1];
    setHiddenIds((previous) => new Set(previous).add(id));
    if (id === selectedId) setSelectedId(next?.id ?? null);
    if (id === focusedId) setFocusedId(next?.id ?? null);
    if (!next && viewerOpen) setViewerOpen(false);
    if (restoreKeyboardFocus && next) gridRef.current?.focus(next.id);
    else if (!next) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.empty-action')?.focus({ preventScroll: true }));
    setNotice('已从本次结果移除；源文件没有改动。切换资料库可重新开始。');
  };
  const stepPicture = (direction: number) => {
    const index = pictures.findIndex((picture) => picture.id === selectedId);
    const next = pictures[Math.max(0, Math.min(pictures.length - 1, index + direction))];
    if (next) { setSelectedId(next.id); setFocusedId(next.id); }
  };
  const toggleTag = (tag: string) => setTags((previous) => previous.includes(tag) ? previous.filter((value) => value !== tag) : [...previous, tag]);
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setImporting(true);
    const added: Picture[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (!/\.(jpe?g|png|webp)$/i.test(file.name)) { rejected.push(file.name); continue; }
      const url = URL.createObjectURL(file);
      const image = new Image();
      try {
        await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('decode')); image.src = url; });
        // Browser natural dimensions account for supported EXIF orientation; no thumbnail rewrite.
        added.push({ id: `local-${crypto.randomUUID()}`, title: file.name, url, width: image.naturalWidth, height: image.naturalHeight, tags: [], source: '此次浏览中选择的本地文件 · 未复制／未修改', kind: 'local' });
        objectUrls.current.add(url);
      } catch { URL.revokeObjectURL(url); rejected.push(file.name); }
    }
    setLocalPictures((previous) => [...previous, ...added]);
    setImporting(false);
    if (added.length) { setCollection('local'); setQuery(''); setTags([]); setSelectedId(null); setViewerOpen(false); }
    setNotice(`已读取 ${added.length} 张到内存${rejected.length ? `；${rejected.length} 项未读取（${rejected.slice(0, 3).join('、')}${rejected.length > 3 ? '等' : ''}），请检查格式或文件` : '。关闭或刷新页面即清空；原文件保留。'}`);
    if (fileRef.current) fileRef.current.value = '';
  };
  const clearLocal = () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear(); setLocalPictures([]); setSelectedId(null); setViewerOpen(false);
    setNotice('本地试排已清空，源文件没有改动。');
  };
  const picker = () => fileRef.current?.click();
  const searchControl = <label className={`search-field ${variant === 'B' ? 'search-prominent' : ''}`}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找名称或样本标签…" aria-label="查找名称或样本标签" />{query && <button className="clear-search" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}<kbd>/</kbd></label>;
  const tagControl = <div className="tag-strip" aria-label="手工样本标签">{sampleTags.map((tag) => <button key={tag} className={`tag-button ${tags.includes(tag) ? 'is-active' : ''}`} aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)}>{tags.includes(tag) && <Check size={12} />}{tag}</button>)}{tags.length > 0 && <button className="text-button" onClick={() => setTags([])}>清除</button>}<span className="tag-note">手工样本标签 · 多项同时满足</span></div>;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.matches('input, textarea, select') || event.target.isContentEditable) return;
      if (event.key === '/' && !modalActive) { event.preventDefault(); document.querySelector<HTMLInputElement>('.search-field input')?.focus(); }
      if (event.key === 'Escape') { if (aOverlay) closeViewer(); else if (bOverlay) closeDetail(); else setDrawer(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aOverlay, bOverlay, focusedId, selected?.id]);

  const gallery = <Masonry key={`${variant}:${collection}`} ref={gridRef} pictures={pictures} selectedId={selectedId} focusedId={focusedId}
    emptyKind={originals.length ? (query.trim() || tags.length ? 'no-match' : 'removed-all') : 'empty-library'}
    onEmptyAction={() => { if (query.trim() || tags.length) { setQuery(''); setTags([]); } else if (originals.length) setHiddenIds(new Set()); else picker(); }}
    density={variant === 'C' ? Math.min(density, 170) : density} uniform={uniform} capTall={capTall} initialAnchor={anchors.current[variant]}
    onSelect={selectPicture} onOpen={openPicture} onFocus={setFocusedId} onState={setGridState} onDelete={removePicture} />;
  const viewer = <Viewer picture={selected} modal={bOverlay} onClose={variant === 'B' ? closeDetail : undefined} onStep={stepPicture} onRemove={() => selected && removePicture(selected.id)} onFiles={picker} />;
  return <div className={`app ${dark ? 'dark' : 'light'} ${reduced ? 'reduce-motion' : ''} variant-${variant}`}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); } }}>
    <input type="file" accept=".jpg,.jpeg,.png,.webp" multiple hidden ref={fileRef} onChange={(event) => void addFiles(Array.from(event.target.files ?? []))} />
    <nav className="icon-rail" aria-label="主要导航" inert={modalActive || undefined}>
      <div className="brand-icon" aria-hidden="true"><Library size={24} strokeWidth={1.8} /></div>
      <div className="rail-actions">
        <span className="nav-indicator" style={{ top: drawer === 'library' ? 0 : drawer === 'settings' ? 100 : 50 }} />
        <NavButton icon={FolderOpen} label="资料库与样本" active={drawer === 'library'} onClick={() => setDrawer(drawer === 'library' ? null : 'library')} />
        <NavButton icon={Images} label="浏览参考图" active={!drawer} onClick={() => { setDrawer(null); closeViewer(); }} />
        <NavButton icon={Settings2} label="显示与操作设置" active={drawer === 'settings'} onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')} />
      </div>
      <div className="rail-bottom"><button className="nav-button" aria-label={dark ? '切换浅色模式' : '切换深色模式'} onClick={() => setDark((value) => !value)}>{dark ? <Sun size={20} /> : <Moon size={20} />}<span className="nav-tooltip">{dark ? '浅色模式' : '深色模式'}</span></button><span className="rail-caption">K</span></div>
    </nav>
    <main className="workspace">
      <div className="browser-surface" inert={aOverlay || undefined}>
      <header className="workspace-header" inert={bOverlay || undefined}>
        <div className="library-title"><span>Kinshoko</span><strong>{libraryName}</strong></div>
        {variant !== 'B' && searchControl}
        <div className="header-actions"><span className="sample-badge">{collection === 'local' ? '内存试排' : '构造样本'}</span><button className="primary-button" onClick={picker} disabled={importing}><ImagePlus size={16} /><span>{importing ? '正在读取…' : '选择本地图片'}</span></button></div>
      </header>
      {variant === 'B' && <section className="search-composition" inert={bOverlay || undefined}><div><h1>找到下一张参考</h1><p>按名称与手工标签筛选，选中后直接观察。</p></div>{searchControl}{tagControl}</section>}
      <div className="browse-toolbar" inert={bOverlay || undefined}>
        <div className="result-summary"><span>{pictures.length.toLocaleString()} 张{query || tags.length ? '匹配' : ''}</span><span className="subtle">{collection === 'samples' ? '重复公开图与夹具，仅验证布局' : '未保存到资料库'}</span></div>
        <div className="browse-controls">
          {variant !== 'B' && <button className={`text-button ${filtersOpen ? 'is-active' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={15} /><span>筛选{tags.length > 0 ? ` ${tags.length}` : ''}</span></button>}
          <label className="sort-label"><span className="sr-only">排序</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="original">原始顺序</option><option value="name">名称顺序</option><option value="reverse">倒序</option></select></label>
          <button className="icon-button compact" aria-label="图片密度与布局对照" onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')}><Grid2X2 size={16} /></button>
          {variant === 'A' && <button className="text-button" disabled={!selected} onClick={() => selected && openPicture(selected)}>查看大图<ArrowRight size={15} /></button>}
        </div>
      </div>
      {variant !== 'B' && filtersOpen && tagControl}
      <div className={`content-region ${variant === 'B' && selected ? 'with-inline-viewer' : ''}`}>
        {variant === 'C' && <div className="observation-pane">{viewer}</div>}
        <div className="gallery-region" inert={modalActive || undefined}>{gallery}</div>
        {variant === 'B' && selected && <div className="inline-detail">{viewer}</div>}
      </div>
      <footer className="workspace-footer" inert={bOverlay || undefined}><span>{importing ? '正在浏览器中读取文件…' : '双击 / Enter 查看 · 方向键按排序移动 · Delete 从本次结果移除'}</span><button onClick={() => setShowState((value) => !value)} aria-expanded={showState}>样稿状态</button></footer>
      </div>
      {variant === 'A' && viewerOpen && <Viewer picture={selected} overlay onClose={closeViewer} onStep={stepPicture} onRemove={() => selected && removePicture(selected.id)} onFiles={picker} />}
    </main>
    {drawer && !modalActive && <aside className="settings-drawer" aria-label={drawer === 'library' ? '资料库与样本' : '显示与操作设置'}>
      <div className="drawer-heading"><h2>{drawer === 'library' ? '资料库与样本' : '显示与操作'}</h2><button className="icon-button" aria-label="关闭面板" onClick={() => setDrawer(null)}><PanelRightClose size={18} /></button></div>
      {drawer === 'library' ? <>
        <p className="drawer-intro">这是一次性界面样稿。资料库入口用于试用状态，尚未连接磁盘数据。</p>
        <div className="library-options">{([['samples', '绘画观察样本', '公开绘画 + 几何夹具'], ['local', '本地试排', `${localPictures.length} 张 · 仅在内存中`], ['empty', '空白资料库', '试用无数据状态']] as const).map(([value, title, subtitle]) => <button key={value} className={collection === value ? 'is-active' : ''} onClick={() => chooseCollection(value)}><FolderOpen size={19} /><span><strong>{title}</strong><small>{subtitle}</small></span>{collection === value && <Check size={16} />}</button>)}</div>
        <label className="field-label">构造记录规模<select value={sampleCount} onChange={(event) => setSampleCount(Number(event.target.value))}><option value={100}>100 条</option><option value={1000}>1,000 条</option><option value={10000}>10,000 条</option></select></label>
        <p className="subtle">大量记录复用少量图片 URL。它验证 DOM 与布局工作量，不能代表真实万张图导入、解码或检索性能。</p>
        <button className="primary-button full" onClick={picker} disabled={importing}><ImagePlus size={16} />选择本地 JPEG / PNG / WebP</button>
        {localPictures.length > 0 && <button className="text-button danger" onClick={clearLocal}>清空本地试排</button>}
        <a className="source-link" href="/samples/SOURCES.md" target="_blank" rel="noreferrer">查看样本来源与许可<ArrowRight size={14} /></a>
      </> : <>
        <label className="field-label">缩略图密度<select value={density} onChange={(event) => setDensity(Number(event.target.value))}><option value={164}>紧凑</option><option value={220}>标准</option><option value={300}>舒展</option></select></label>
        <label className="check-option"><input type="checkbox" checked={uniform} onChange={(event) => setUniform(event.target.checked)} /><span>等尺寸网格对照<small>用于比较留白，图片仍完整展示</small></span></label>
        <label className="check-option"><input type="checkbox" checked={capTall} onChange={(event) => setCapTall(event.target.checked)} /><span>限制极长图高度<small>最多 560px，等比缩小并保留全图</small></span></label>
        <label className="check-option"><input type="checkbox" checked={dark} onChange={(event) => setDark(event.target.checked)} /><span>深色观察表面</span></label>
        <label className="check-option"><input type="checkbox" checked={reduced} onChange={(event) => setReduced(event.target.checked)} /><span>减少动画<small>也遵守系统的减少动画偏好</small></span></label>
        <div className="settings-help"><h3>键盘与观察</h3><p>/ 聚焦搜索；Tab 进入图片。左右键按排序移动，上下键跨当前列数；Enter 查看，空格选中，Esc 返回。</p><p>原图以浏览器支持的方向解码，查看支持适应、原始尺寸（CSS）与缩放。色彩、GPU、混合 DPI 和桌面置顶不在这次网页样稿中验收。</p></div>
      </>}
    </aside>}
    {dragging && <div className="drop-zone"><ImagePlus size={32} /><strong>放开，试排这些参考图</strong><span>JPEG / PNG / WebP · 原文件不改动</span></div>}
    {notice && <div className="notice" role="status" inert={modalActive || undefined}><span>{notice}</span><button className="icon-button compact" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {showState && <aside className="state-report" aria-label="原型诊断状态" inert={modalActive || undefined}><div><strong>样稿状态</strong><button className="icon-button compact" aria-label="收起状态" onClick={() => setShowState(false)}><X size={14} /></button></div><dl><dt>结构 / 布局</dt><dd>{variant} / {uniform ? '等尺寸对照' : 'TanStack lanes'}</dd><dt>匹配 / 总记录</dt><dd>{pictures.length} / {originals.length}</dd><dt>列 / 卡片 DOM</dt><dd>{gridState.columns} / {gridState.mounted}</dd><dt>滚动 / 内容宽度</dt><dd>{gridState.scroll}px / {gridState.width}px</dd><dt>选中 ID</dt><dd>{selectedId ?? '无'}</dd><dt>焦点 ID</dt><dd>{focusedId ?? '无'}</dd></dl><p>诊断值随操作变化；未测量原生应用性能。</p></aside>}
    {import.meta.env.DEV && <div inert={modalActive || undefined}><PrototypeSwitcher variant={variant} onChange={changeVariant} /></div>}
  </div>;
}
