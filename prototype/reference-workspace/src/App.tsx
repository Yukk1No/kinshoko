import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Check, ChevronDown, ChevronRight, Folder as FolderIcon, FolderOpen, FolderPlus, GalleryVerticalEnd, HelpCircle, Images, LibraryBig, Moon, PanelLeft, Plus, Search, SlidersHorizontal, Sun, Upload, X } from 'lucide-react';
import Masonry from './Masonry';
import type { Anchor, GridHandle } from './Masonry';
import CropEditor, { CropPicture } from './CropEditor';
import ReferenceBoard from './ReferenceBoard';
import { Modal, NameDialog } from './Dialog';
import { cloneMembers, folderBranch, folderPath, initialFolders, initialGroups, initialPictures, initialQueries, libraries, matches, nextId } from './data';
import type { Crop, Folder, Picture, Query, Reference, ReferenceGroup, SavedQuery } from './data';

type Variant = 'A' | 'B' | 'C';
type Stage = 'find' | 'take' | 'use';
const variants: { id: Variant; name: string; description: string }[] = [
  { id: 'A', name: '专注取用', description: '找图、取用、绘画参考，一次专注一个任务。' },
  { id: 'B', name: '查找台', description: '图片墙保持在眼前，取出的参考积累在下方。' },
  { id: 'C', name: '并排工作台', description: '一边找图，一边摆放绘画参考。' },
];
const demoControls = import.meta.env.DEV || import.meta.env.MODE === 'demo';
const queryStart: Query = { libraryId: 'art', folderId: 'all', descendants: true, text: '', tags: [] };

function SourceNavigator({ query, folders, pictures, savedQueries, expanded, onExpand, onFolder, onQuery, onCreate, onClose }: {
  query: Query; folders: Folder[]; pictures: Picture[]; savedQueries: SavedQuery[];
  expanded: Set<string>; onExpand: (next: Set<string>) => void;
  onFolder: (id: string) => void; onQuery: (query: Query) => void; onCreate: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const next = new Set(expanded);
    let parent = folders.find(folder => folder.id === query.folderId)?.parentId;
    while (parent) { next.add(parent); parent = folders.find(folder => folder.id === parent)?.parentId; }
    if (next.size !== expanded.size) onExpand(next);
  }, [query.folderId, folders]);
  const libraryPictures = pictures.filter(picture => picture.libraryId === query.libraryId);
  const count = (id: string) => libraryPictures.filter(picture => picture.folderIds.some(folderId => folderBranch(id, folders).includes(folderId))).length;
  const branch = (parent: string | null, level = 0) => folders.filter(folder => folder.libraryId === query.libraryId && folder.parentId === parent).map(folder => {
    const children = folders.some(child => child.parentId === folder.id);
    return <div key={folder.id} className="folder-branch">
      <div className={`folder-row ${query.folderId === folder.id ? 'is-current' : ''}`} style={{ paddingLeft: 8 + level * 16 }}>
        {children ? <button className="tree-disclosure" aria-label={`${expanded.has(folder.id) ? '收起' : '展开'} ${folder.name}`} aria-expanded={expanded.has(folder.id)} onClick={() => { const next = new Set(expanded); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); onExpand(next); }}>{expanded.has(folder.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="tree-spacer" />}
        <button className="folder-target" aria-pressed={query.folderId === folder.id} onClick={() => onFolder(folder.id)}>{query.folderId === folder.id ? <FolderOpen size={16} /> : <FolderIcon size={16} />}<span>{folder.name}</span><small>{count(folder.id)}</small></button>
      </div>
      {children && expanded.has(folder.id) && branch(folder.id, level + 1)}
    </div>;
  });
  return <div className="source-content">
    <header className="source-heading"><h2>浏览资料</h2><button className="icon-button" aria-label="收起分类导航" onClick={onClose}><PanelLeft size={17} /></button></header>
    <div className="source-start"><button className={query.folderId === 'all' ? 'is-current' : ''} aria-pressed={query.folderId === 'all'} onClick={() => onFolder('all')}><Images size={17} /><span>全部图片</span><small>{libraryPictures.length}</small></button><button className={query.folderId === 'unfiled' ? 'is-current' : ''} aria-pressed={query.folderId === 'unfiled'} onClick={() => onFolder('unfiled')}><FolderOpen size={17} /><span>未归类</span><small>{libraryPictures.filter(picture => !picture.folderIds.length).length}</small></button></div>
    <div className="source-section-heading"><h3>文件夹</h3><button className="icon-button" aria-label="新建文件夹" title="在当前文件夹下新建" onClick={onCreate}><FolderPlus size={17} /></button></div>
    <div className="folder-tree" aria-label="文件夹层级">{branch(null)}</div>
    <div className="source-section-heading"><h3>常用查找</h3></div>
    <div className="saved-queries">{savedQueries.filter(item => item.query.libraryId === query.libraryId).map(item => <button key={item.id} onClick={() => onQuery({ ...item.query, tags: [...item.query.tags] })}><Bookmark size={16} /><span>{item.name}</span></button>)}{!savedQueries.some(item => item.query.libraryId === query.libraryId) && <p>找到好用的条件后，可以保存下来。</p>}</div>
    <p className="source-footnote">先收集也没关系。<br />文件夹与标签可以之后再整理。</p>
  </div>;
}

export default function App() {
  const initialVariant = new URLSearchParams(location.search).get('variant');
  const [variant, setVariant] = useState<Variant>(initialVariant === 'B' || initialVariant === 'C' ? initialVariant : 'A');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [query, setQuery] = useState<Query>(queryStart);
  const [pictures, setPictures] = useState<Picture[]>(initialPictures);
  const [folders, setFolders] = useState<Folder[]>(initialFolders);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(initialQueries);
  const [groups, setGroups] = useState<ReferenceGroup[]>(initialGroups);
  const [members, setMembers] = useState<Reference[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [groupDirty, setGroupDirty] = useState(false);
  const [stage, setStage] = useState<Stage>('find');
  const [page, setPage] = useState<'workspace' | 'groups'>('workspace');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(initialVariant !== 'C');
  const [folderExpanded, setFolderExpanded] = useState(new Set(['character', 'composition', 'checks']));
  const [mobilePane, setMobilePane] = useState(false);
  const [mobileTask, setMobileTask] = useState<'find' | 'use'>('find');
  const [libraryDialog, setLibraryDialog] = useState(false);
  const [nameDialog, setNameDialog] = useState<'folder' | 'query' | 'group' | null>(null);
  const [info, setInfo] = useState(false);
  const [moreTags, setMoreTags] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pendingGroup, setPendingGroup] = useState<ReferenceGroup | 'new' | null>(null);
  const grid = useRef<GridHandle>(null);
  const anchor = useRef<Anchor | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const localUrls = useRef<string[]>([]);
  const visible = useMemo(() => pictures.filter(picture => matches(picture, query, folders)), [pictures, query, folders]);
  const selected = pictures.find(picture => picture.id === selectedId);
  const library = libraries.find(item => item.id === query.libraryId)!;
  const group = groups.find(item => item.id === groupId);
  const scope = query.folderId === 'all' ? '全部图片' : query.folderId === 'unfiled' ? '未归类' : folderPath(query.folderId, folders).join(' / ');
  const libraryTags = [...new Set(pictures.filter(picture => picture.libraryId === query.libraryId).flatMap(picture => picture.tags))];
  const hasFilters = Boolean(query.text.trim() || query.tags.length);
  const sourceNav = <SourceNavigator query={query} folders={folders} pictures={pictures} savedQueries={savedQueries} expanded={folderExpanded} onExpand={setFolderExpanded}
    onFolder={id => { setQuery(previous => ({ ...previous, folderId: id })); setMobilePane(false); }}
    onQuery={next => { setQuery(next); setMobilePane(false); }}
    onCreate={() => { setMobilePane(false); setNameDialog('folder'); }} onClose={() => { setSourceOpen(false); setMobilePane(false); }} />;
  const changeMembers = (next: Reference[]) => { setMembers(next); setGroupDirty(true); };
  const returnFind = () => { setPage('workspace'); setStage('find'); setMobileTask('find'); };
  const useReferences = () => { setPage('workspace'); setStage('use'); setMobileTask('use'); };
  const inspect = (picture: Picture) => { anchor.current = grid.current?.capture() ?? anchor.current; setSelectedId(picture.id); setFocusedId(picture.id); setStage('take'); };
  const changeVariant = (next: Variant) => {
    anchor.current = grid.current?.capture() ?? anchor.current;
    setVariant(next); returnFind(); setSourceOpen(next !== 'C');
    const url = new URL(location.href); url.searchParams.set('variant', next); history.replaceState(null, '', url);
    console.info('Kinshoko prototype state', { variant: next, query, members, groups, folders, savedQueries });
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (page !== 'workspace' || stage !== 'find' || mobileTask !== 'find') return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]') || (target instanceof Element && target.closest('input, textarea, select, button, [contenteditable="true"], .masonry-scroll, .reference-board'))) return;
      if (!demoControls || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const index = variants.findIndex(item => item.id === variant);
      changeVariant(variants[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3].id);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => localUrls.current.forEach(url => URL.revokeObjectURL(url)), []);
  useEffect(() => {
    if (page === 'workspace' && stage === 'find' && selectedId) grid.current?.restore(anchor.current, focusedId ?? selectedId);
  }, [page, stage, variant]);
  const addReference = (crop: Crop, useNow: boolean) => {
    if (!selected) return;
    const member: Reference = { id: nextId('view'), libraryId: selected.libraryId, imageId: selected.id, crop: { ...crop }, x: (members.length % 3) * .32 + .06, y: (Math.floor(members.length / 3) % 3) * .28 + .08, width: .3, locked: false };
    changeMembers([...members, member]);
    setNotice(`已加入${crop.w === 1 && crop.h === 1 ? '整图' : '局部'}参考`);
    if (useNow) useReferences(); else returnFind();
  };
  const saveName = (name: string) => {
    if (nameDialog === 'folder') {
      const parent = folders.find(folder => folder.id === query.folderId);
      const folder: Folder = { id: nextId('folder'), libraryId: query.libraryId, name, parentId: parent?.id ?? null };
      setFolders(previous => [...previous, folder]); setQuery(previous => ({ ...previous, folderId: folder.id }));
      setNotice(`已创建文件夹「${name}」，可在原图详情中添加图片`);
    } else if (nameDialog === 'query') {
      setSavedQueries(previous => [...previous, { id: nextId('query'), name, query: { ...query, tags: [...query.tags] } }]);
      setNotice(`已保存常用查找「${name}」`);
    } else {
      const id = groupId ?? nextId('group');
      const saved = { id, name, members: cloneMembers(members) };
      setGroups(previous => groupId ? previous.map(item => item.id === id ? saved : item) : [...previous, saved]);
      setGroupId(id); setGroupDirty(false); setNotice(`已保存参考组「${name}」`);
      if (pendingGroup === 'new') startNewGroup();
      else if (pendingGroup) openGroup(pendingGroup);
    }
    setNameDialog(null);
  };
  const openGroup = (next: ReferenceGroup) => { setMembers(cloneMembers(next.members)); setGroupId(next.id); setGroupDirty(false); setPendingGroup(null); useReferences(); };
  const startNewGroup = () => { setMembers([]); setGroupId(null); setGroupDirty(false); setPendingGroup(null); returnFind(); };
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const targetLibraryId = query.libraryId;
    const targetFolder = folders.find(folder => folder.id === query.folderId);
    setBusy(true);
    const result = await Promise.all(Array.from(files).map(async file => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return null;
      const url = URL.createObjectURL(file), image = new window.Image(); image.src = url;
      try {
        await image.decode(); localUrls.current.push(url);
        const picture: Picture = { id: nextId('local'), title: file.name, url, width: image.naturalWidth, height: image.naturalHeight, tags: [], source: '所选本地文件 · 仅在本次试用中保留', kind: 'local', libraryId: targetLibraryId, folderIds: targetFolder ? [targetFolder.id] : [] };
        return picture;
      } catch { URL.revokeObjectURL(url); return null; }
    }));
    const loaded = result.filter((picture): picture is Picture => picture !== null);
    setPictures(previous => [...loaded, ...previous]); setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
    if (loaded.length) setQuery(previous => ({ ...previous, libraryId: targetLibraryId, folderId: targetFolder?.id ?? 'all', text: '', tags: [] }));
    setNotice(`已载入 ${loaded.length} 张图片${loaded.length < files.length ? `；${files.length - loaded.length} 张格式不支持或无法读取` : '，文件留在你的设备上'}`);
  };
  const taking = selected && <CropEditor key={selected.id} picture={selected} folders={folders} onBack={returnFind} onAdd={addReference}
    onFolders={ids => setPictures(previous => previous.map(picture => picture.id === selected.id ? { ...picture, folderIds: ids } : picture))}
    onTags={tags => setPictures(previous => previous.map(picture => picture.id === selected.id ? { ...picture, tags } : picture))} />;
  const board = (compact = false) => <ReferenceBoard compact={compact} members={members} pictures={pictures} name={group ? `${group.name}${groupDirty ? ' · 未保存修改' : ''}` : ''} onChange={changeMembers} onFind={returnFind} onSave={() => setNameDialog('group')} />;
  const findPane = <section className="find-pane" aria-label="查找参考图">
    <div className="find-controls">
      <div className="search-row"><div className="search-box"><Search size={18} /><input ref={searchInput} aria-label="搜索名称或标签" placeholder="搜名称或标签，例如：长发 服饰" value={query.text} onChange={event => setQuery(previous => ({ ...previous, text: event.target.value }))} />{query.text && <button className="icon-button" aria-label="清除搜索文字" onClick={() => { setQuery(previous => ({ ...previous, text: '' })); searchInput.current?.focus(); }}><X size={15} /></button>}</div><button className="import-button" aria-label={busy ? "正在载入图片" : "加入本地图片"} onClick={() => fileInput.current?.click()} disabled={busy}><Upload size={16} /><span>{busy ? '载入中' : '加入图片'}</span></button></div>
      <div className="scope-row"><button className="scope-button" onClick={() => { if (matchMedia('(max-width: 720px)').matches) setMobilePane(true); else setSourceOpen(value => !value); }}><PanelLeft size={16} /><span>{scope}</span><ChevronDown size={14} /></button>{query.folderId !== 'all' && <button className="plain-button" onClick={() => setQuery(previous => ({ ...previous, folderId: 'all' }))}>回到全库</button>}<span className="result-count">{visible.length} 张</span><button className="icon-button" aria-label="保存当前查找条件" title="保存为常用查找" onClick={() => setNameDialog('query')}><Bookmark size={17} /></button></div>
      {!['all', 'unfiled'].includes(query.folderId) && <label className="descendant-toggle"><input type="checkbox" checked={query.descendants} onChange={event => setQuery(previous => ({ ...previous, descendants: event.target.checked }))} />包含子文件夹</label>}
      <div className="tag-choices" aria-label="按标签缩小范围">{(moreTags ? libraryTags : libraryTags.slice(0, 5)).map(tag => <button key={tag} aria-pressed={query.tags.includes(tag)} className={query.tags.includes(tag) ? 'tag is-on' : 'tag'} onClick={() => setQuery(previous => ({ ...previous, tags: previous.tags.includes(tag) ? previous.tags.filter(item => item !== tag) : [...previous.tags, tag] }))}>{query.tags.includes(tag) && <Check size={13} />}{tag}</button>)}{libraryTags.length > 5 && <button className="plain-button more-tags" aria-expanded={moreTags} onClick={() => setMoreTags(value => !value)}><SlidersHorizontal size={14} />{moreTags ? '收起' : '更多特征'}</button>}</div>
      {hasFilters && <div className="active-query"><span>同时满足</span>{query.text && <button onClick={() => setQuery(previous => ({ ...previous, text: '' }))}>文字：{query.text}<X size={12} /></button>}{query.tags.map(tag => <button key={tag} onClick={() => setQuery(previous => ({ ...previous, tags: previous.tags.filter(item => item !== tag) }))}>{tag}<X size={12} /></button>)}<button className="plain-button" onClick={() => setQuery(previous => ({ ...previous, text: '', tags: [] }))}>清空条件</button></div>}
    </div>
    <Masonry ref={grid} pictures={visible} selectedId={selectedId} focusedId={focusedId} density={variant === 'C' ? 175 : 210} uniform={false} capTall={false} initialAnchor={anchor.current} emptyKind={pictures.every(picture => picture.libraryId !== query.libraryId) ? "empty-library" : !hasFilters && !visible.length ? "empty-scope" : "no-match"}
      onEmptyAction={() => { if (pictures.every(picture => picture.libraryId !== query.libraryId)) fileInput.current?.click(); else setQuery(previous => ({ ...previous, folderId: hasFilters ? previous.folderId : 'all', text: '', tags: [] })); }} onSelect={inspect} onOpen={inspect} onFocus={setFocusedId} onState={() => {}} onDelete={() => {}} />
  </section>;
  const groupHome = <section className="group-home"><div className="group-intro"><h2>用过的参考，留着下次画</h2><p>保存整图、局部和摆放位置。一个组可以取用不同资料库的图片。</p></div><div className="group-list">{groups.map(item => <article className="group-preview" key={item.id}><div className="group-preview-images">{item.members.slice(0, 3).map(member => { const image = pictures.find(picture => picture.id === member.imageId && picture.libraryId === member.libraryId); return image ? <CropPicture key={member.id} picture={image} crop={member.crop} /> : <span key={member.id}>来源暂不可用</span>; })}</div><div className="group-preview-caption"><div><h3>{item.name}</h3><p>{item.members.length} 个参考 · {new Set(item.members.map(member => member.libraryId)).size} 个资料库</p></div><button onClick={() => { if (members.length && groupDirty) setPendingGroup(item); else openGroup(item); }}>打开<ArrowRight size={15} /></button></div></article>)}</div><button className="new-workspace" onClick={() => { if (members.length && groupDirty) setPendingGroup("new"); else startNewGroup(); }}><Plus size={18} />开始一组新参考</button></section>;

  return <div className={`reference-demo variant-${variant} theme-${theme} ${demoControls ? "has-demo-controls" : ""} ${stage === "use" ? "is-using" : ""}`}>
    <nav className="icon-rail" aria-label="主要功能"><div className="brand-mark" title="Kinshoko"><LibraryBig size={25} /></div><button className={`rail-button ${page === 'workspace' ? 'is-active' : ''}`} aria-label="查找与取用参考" aria-current={page === 'workspace' ? 'page' : undefined} title="查找与取用" onClick={returnFind}><Search size={23} /></button><button className={`rail-button ${page === 'groups' ? 'is-active' : ''}`} aria-label="打开参考组列表" aria-current={page === 'groups' ? 'page' : undefined} title="参考组" onClick={() => { anchor.current = grid.current?.capture() ?? anchor.current; setPage('groups'); }}><GalleryVerticalEnd size={23} /></button><div className="rail-bottom"><button className="rail-button" aria-label="试用说明" title="试用说明" onClick={() => setInfo(true)}><HelpCircle size={21} /></button><button className="rail-button" aria-label={`切换${theme === 'dark' ? '浅色' : '深色'}主题`} title="切换主题" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />}</button></div></nav>
    <div className="workspace-shell"><header className="workspace-header"><div className="heading-block"><h1>{page === 'groups' ? '参考组' : stage === 'use' ? '绘画参考' : stage === 'take' && variant === 'A' ? '取出参考' : '查找参考'}</h1>{page === 'workspace' && stage !== 'use' && <button className="library-switch" onClick={() => setLibraryDialog(true)} aria-label={`切换资料库，当前为${library.name}`}><LibraryBig size={14} />{library.name}<ChevronDown size={13} /></button>}</div>
      {page === 'groups' ? <button onClick={returnFind}><ArrowLeft size={16} />返回查找</button> : variant === 'A' ? <nav className="stage-nav" aria-label="参考取用流程"><button aria-current={stage === 'find' ? 'step' : undefined} onClick={returnFind}><span>1</span>找图</button><ChevronRight size={13} /><button aria-current={stage === 'take' ? 'step' : undefined} disabled={!selected} onClick={() => { if (selected) inspect(selected); }}><span>2</span>取用</button><ChevronRight size={13} /><button aria-current={stage === 'use' ? 'step' : undefined} onClick={useReferences}><span>3</span>参考{members.length > 0 && <small>{members.length}</small>}</button></nav> : <button className="current-references" onClick={stage === 'use' ? returnFind : useReferences}>{stage === 'use' ? <Search size={17} /> : <Images size={17} />}{stage === 'use' ? '继续找图' : variant === 'C' ? '展开参考区' : `绘画参考 · ${members.length}`}</button>}
    </header>
    {page === 'groups' ? groupHome : stage === 'take' && selected && variant === 'A' ? taking : stage === 'use' ? <div className="full-board">{board()}</div> : <>
      {variant === 'C' && <div className="mobile-task-nav"><button aria-pressed={mobileTask === 'find'} onClick={() => setMobileTask('find')}>找图</button><button aria-pressed={mobileTask === 'use'} onClick={() => setMobileTask('use')}>绘画参考 · {members.length}</button></div>}
      <div className={`lookup-workspace ${sourceOpen ? 'with-sources' : ''} mobile-task-${mobileTask}`}>
        {sourceOpen && <aside className="source-pane" aria-label="资料分类">{sourceNav}</aside>}
        {findPane}
        {variant === 'C' && <div className="adjacent-board">{board(true)}</div>}
      </div>
      {variant === 'B' && <section className="reference-tray" aria-label="本次取出的参考"><div className="tray-heading"><h2>这次绘画 <small>{members.length}</small></h2><button onClick={useReferences}>摆放参考<ArrowRight size={15} /></button></div><div className="tray-items">{members.length ? members.map(member => { const picture = pictures.find(image => image.id === member.imageId); return picture ? <button className="tray-item" key={member.id} title={picture.title} onClick={useReferences}><CropPicture picture={picture} crop={member.crop} /><span>{member.crop.w === 1 && member.crop.h === 1 ? '整图' : '局部'}</span></button> : null; }) : <p>点击图片，选择整图或局部。取出的参考会留在这里。</p>}</div></section>}
    </>}
    </div>
    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event => void importFiles(event.target.files)} />
    {stage === 'take' && selected && variant !== 'A' && <Modal className="taking-modal" title="取出参考" onClose={returnFind}>{taking}</Modal>}
    {mobilePane && <Modal className="source-modal" title="资料分类" onClose={() => setMobilePane(false)}>{sourceNav}</Modal>}
    {libraryDialog && <Modal title="选择资料库" onClose={() => setLibraryDialog(false)}><div className="library-list">{libraries.map(item => <button key={item.id} aria-pressed={query.libraryId === item.id} onClick={() => { setQuery({ ...queryStart, libraryId: item.id }); setSelectedId(null); setFocusedId(null); anchor.current = undefined; setLibraryDialog(false); if (stage === 'take') returnFind(); setNotice('已切换资料库，当前绘画参考仍保留'); }}><LibraryBig size={23} /><span><strong>{item.name}</strong><small>{item.description}</small></span>{query.libraryId === item.id && <Check size={18} />}</button>)}</div><p className="dialog-note">资料库各自管理原图；参考组可以跨库取用。</p></Modal>}
    {nameDialog && <NameDialog key={nameDialog} title={nameDialog === 'folder' ? '新建文件夹' : nameDialog === 'query' ? '保存常用查找' : '保存参考组'} label={nameDialog === 'folder' ? '文件夹名称' : nameDialog === 'query' ? '查找名称' : '参考组名称'} initial={nameDialog === 'group' ? group?.name : ''} onClose={() => setNameDialog(null)} onSave={saveName} hint={nameDialog === 'folder' ? `放在${folders.some(folder => folder.id === query.folderId) ? `「${scope}」下` : '资料库根目录'}。` : nameDialog === 'query' ? '保存范围和条件，以后点击即可再次查找。' : '保存来源引用、局部范围和摆放位置。样稿刷新后会重置。'} />}
    {pendingGroup && !nameDialog && <Modal title="打开另一组参考" onClose={() => setPendingGroup(null)}><p className="dialog-note">当前参考还有未保存的修改。先保存，或{pendingGroup === "new" ? "开始一组新参考" : `直接打开「${pendingGroup.name}」`}。</p><div className="dialog-actions"><button onClick={() => setNameDialog('group')}>先保存当前参考</button><button className="primary-button" onClick={() => pendingGroup === "new" ? startNewGroup() : openGroup(pendingGroup)}>{pendingGroup === "new" ? "开始新参考" : "直接打开"}</button></div></Modal>}
    {info && <Modal title="试用这个工作流" onClose={() => setInfo(false)}><div className="trial-info"><p>从文件夹或标签找图，取出整图或局部，摆放后保存成参考组。A / B / C 比较三种任务组织方式。</p><p>示例库使用公开作品与自制几何样本；标签由人工编写。可以加入自己的 PNG、JPEG、WebP，文件只在你的设备上读取。</p><p>这是内存样稿，刷新会重置。网页参考窗口模拟桌面使用，真实置顶、备份、同步与自动打标尚未接入。</p><a href="/samples/SOURCES.md" target="_blank" rel="noreferrer">查看样本来源</a><details><summary>当前试用状态</summary><pre>{JSON.stringify({ variant, stage, query, members, groups: groups.map(item => ({ name: item.name, members: item.members })) }, null, 2)}</pre></details></div></Modal>}
    {notice && <div className="notice" role="status"><Check size={16} /><span>{notice}</span>{members.length > 0 && stage !== 'use' && <button onClick={() => { useReferences(); setNotice(''); }}>查看参考</button>}<button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {demoControls && <div className="demo-switcher" aria-label="比较交互方案"><button className="icon-button" aria-label="上一个交互方案" onClick={() => changeVariant(variants[(variants.findIndex(item => item.id === variant) + 2) % 3].id)}><ArrowLeft size={15} /></button>{variants.map(item => <button key={item.id} title={item.description} aria-pressed={variant === item.id} onClick={() => changeVariant(item.id)}><span>{item.id}</span>{item.name}</button>)}<button className="icon-button" aria-label="下一个交互方案" onClick={() => changeVariant(variants[(variants.findIndex(item => item.id === variant) + 1) % 3].id)}><ArrowRight size={15} /></button></div>}
  </div>;
}
