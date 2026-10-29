import { useMemo, useState } from 'react';
import { ExternalLink, FolderPlus, Plus, RotateCcw, Sparkles, Star, X } from 'lucide-react';
import type { Curation, Folder, Library, Rating, ReferenceImage, TagDef, TagKey, TagState } from '../model';
import { RATING_LABEL, effectiveFolders, effectiveRating, imageKey, tagStates } from '../model';
import { candidates } from '../search';
import { Untranslated } from './Untranslated';

type Props = {
  image: ReferenceImage;
  library: Library;
  dict: Record<TagKey, TagDef>;
  counts: Map<TagKey, number>;
  curation: Curation;
  hasPredictions: boolean;
  onTag: (key: TagKey, decision: 'add' | 'reject' | null) => void;
  onCreateTag: (name: string) => void;
  onRating: (rating: Rating | null) => void;
  onFolder: (folderId: string, decision: 'add' | 'remove' | null) => void;
  onNote: (note: string) => void;
  onFind: (key: TagKey) => void;
};

const SECTION_ORDER: { ns: TagDef['ns']; label: string }[] = [{ ns: '角色', label: '角色' }, { ns: '作品', label: '作品' }, { ns: '一般', label: '一般' }];

export function InfoPanel(p: Props) {
  const { image, dict, curation } = p;
  const key = imageKey(image);
  const states = tagStates(image, curation);
  const decisions = curation.tags[key] ?? {};
  const authors = states.filter((s) => dict[s.key]?.ns === '作者' && !s.rejected);
  const rating = effectiveRating(image, curation);
  const ratingManual = key in curation.rating;
  const folders = effectiveFolders(image, curation);
  const folderDecisions = curation.folders[key] ?? {};
  const removedFolders = Object.entries(folderDecisions).filter(([, d]) => d === 'remove').map(([f]) => f);
  const [adding, setAdding] = useState('');
  const [folderPick, setFolderPick] = useState(false);
  const suggestions = useMemo(() => candidates(adding, p.dict, p.counts, 6).filter((c) => !states.some((s) => s.key === c.key && !s.rejected)), [adding, p.dict, p.counts, states]);

  const path = (f: Folder) => {
    const names = [f.name];
    let parent = f.parent;
    while (parent) { const x = p.library.folders.find((y) => y.id === parent); if (!x) break; names.unshift(x.name); parent = x.parent; }
    return names.join(' / ');
  };

  return <aside className="info" aria-label="参考图信息">
    {/* Author sits at the top beside the source links (Q94); in storage it is an ordinary namespaced tag. */}
    <section className="info-head">
      {authors.length ? authors.map((a) => <button key={a.key} className="author" onClick={() => p.onFind(a.key)} title="查看这位作者的全部图">
        <span className="muted">作者</span><strong>{dict[a.key].name}</strong>
      </button>) : <span className="muted">作者未记录</span>}
      <ul className="links">
        {image.sourceLinks.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer"><ExternalLink size={12} />{l.url.replace(/^https?:\/\/(www\.)?/, '')}</a><span className="from">{l.from}</span></li>)}
        {!image.sourceLinks.length && <li className="muted">没有来源链接</li>}
      </ul>
    </section>

    <section>
      <h3 className="info-title">{image.title}</h3>
      <dl className="facts">
        <dt>尺寸</dt><dd className="tabular">{image.w} × {image.h} px · {image.format}{image.viewScale < 1 ? ` · 样稿查看用 ${Math.round(image.viewScale * 100)}% 副本` : ''}</dd>
        <dt>资料库</dt><dd>{p.library.name}</dd>
        {image.sha256 && <><dt>哈希</dt><dd className="tabular muted">{image.sha256.slice(0, 16)}…</dd></>}
      </dl>
    </section>

    <section>
      <h4>内容分级</h4>
      <div className="rating-row">
        <select value={rating} onChange={(e) => p.onRating(e.target.value === image.rating.value && !ratingManual ? null : e.target.value as Rating)} aria-label="内容分级">
          {(Object.keys(RATING_LABEL) as Rating[]).map((r) => <option key={r} value={r}>{RATING_LABEL[r]}</option>)}
        </select>
        {ratingManual
          ? <><span className="origin manual"><Star size={11} />人工</span><button className="link" onClick={() => p.onRating(null)}>恢复来源分级</button></>
          : <span className="origin">{image.rating.from}</span>}
      </div>
    </section>

    <section>
      <h4>标签 <span className="legend"><span className="origin">来源</span><span className="origin auto"><Sparkles size={11} />自动</span><span className="origin manual"><Star size={11} />人工</span></span></h4>
      {SECTION_ORDER.map(({ ns, label }) => {
        const list = states.filter((s) => dict[s.key]?.ns === ns && !s.rejected);
        if (!list.length) return null;
        return <div key={ns} className="tag-section">
          <span className="ns-label">{label}</span>
          <div className="chips">{list.map((s) => <TagChip key={s.key} state={s} def={dict[s.key]} decided={s.key in decisions} onFind={() => p.onFind(s.key)}
            onReject={() => p.onTag(s.key, s.origin === 'manual' ? null : 'reject')} />)}</div>
        </div>;
      })}
      <div className="tag-add">
        <Plus size={14} />
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="添加标签，例如 中分"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) {
              const first = suggestions[0];
              if (first) p.onTag(first.key, 'add'); else p.onCreateTag(adding.trim());
              setAdding('');
            }
          }} aria-label="添加标签" />
      </div>
      {adding && <ul className="mini-suggest">
        {suggestions.map((c) => <li key={c.key}><button onClick={() => { p.onTag(c.key, 'add'); setAdding(''); }}>
          <span className="ns">{c.def.ns === '一般' ? '' : `${c.def.ns}：`}</span>{c.def.name}<Untranslated def={c.def} />{c.via && <span className="muted"> ← {c.via}</span>}</button></li>)}
        {!suggestions.some((c) => c.def.name === adding.trim()) && <li><button onClick={() => { p.onCreateTag(adding.trim()); setAdding(''); }}>新建标签“{adding.trim()}”</button></li>}
      </ul>}
      {states.some((s) => s.rejected) && <div className="rejected">
        <span className="muted">已否决（不参与查找）</span>
        {states.filter((s) => s.rejected).map((s) => <button key={s.key} className="chip is-rejected" onClick={() => p.onTag(s.key, null)} title="撤销否决，回到来源结果">
          {dict[s.key]?.name ?? s.key}<RotateCcw size={11} /></button>)}
      </div>}
      <p className="note-line">{p.hasPredictions ? '自动标签来自 #6 打标探测结果。' : '自动标签建议：这批样本尚未并入 #6 的打标结果，目前只有 pixiv 来源标签与人工决定。'}</p>
    </section>

    <section>
      <h4>文件夹</h4>
      <ul className="folder-list">
        {folders.map((id) => {
          const f = p.library.folders.find((x) => x.id === id);
          if (!f) return null;
          const manual = folderDecisions[id] === 'add';
          return <li key={id}><span>{path(f)}</span>{manual && <span className="origin manual"><Star size={11} />人工</span>}
            <button className="icon-mini" title="移出这个文件夹" aria-label={`移出 ${f.name}`} onClick={() => p.onFolder(id, manual ? null : 'remove')}><X size={12} /></button></li>;
        })}
        {!folders.length && <li className="muted">不在任何文件夹中</li>}
      </ul>
      {removedFolders.length > 0 && <p className="note-line">已移出：{removedFolders.map((id) => {
        const f = p.library.folders.find((x) => x.id === id);
        return f && <button key={id} className="link" onClick={() => p.onFolder(id, null)}>{f.name} ↺</button>;
      })}</p>}
      <button className="tool small" onClick={() => setFolderPick((v) => !v)}><FolderPlus size={14} />加入文件夹</button>
      {folderPick && <ul className="mini-suggest">
        {p.library.folders.filter((f) => !folders.includes(f.id)).map((f) => <li key={f.id}><button onClick={() => { p.onFolder(f.id, 'add'); setFolderPick(false); }}>{path(f)}</button></li>)}
      </ul>}
    </section>

    <section>
      <h4>备注</h4>
      <textarea value={curation.notes[key] ?? ''} onChange={(e) => p.onNote(e.target.value)} placeholder="写给以后的自己，例如“看袖口褶皱”" rows={3} />
    </section>
  </aside>;
}

function TagChip({ state, def, decided, onFind, onReject }: { state: TagState; def?: TagDef; decided: boolean; onFind: () => void; onReject: () => void }) {
  const cls = state.origin === 'manual' ? ' manual' : state.origin === 'auto' ? ' auto' : '';
  const title = state.origin === 'manual' ? '人工添加' : state.origin === 'auto' ? `自动建议 ${Math.round((state.score ?? 0) * 100)}%` : `来源：${state.from}`;
  return <span className={`chip${cls}`} title={title}>
    <button className="chip-main" onClick={onFind}>{state.origin === 'manual' && <Star size={10} />}{state.origin === 'auto' && <Sparkles size={10} />}{def?.name ?? state.key}<Untranslated def={def} /></button>
    <button className="chip-x" onClick={onReject} aria-label={state.origin === 'manual' ? '撤销添加' : '否决这个标签'} title={state.origin === 'manual' || decided ? '撤销' : '否决：之后重新识别也不会加回来'}><X size={10} /></button>
  </span>;
}
