import { useState } from 'react';
import { ChevronRight, Folder as FolderIcon, FolderSearch, Images, Trash2 } from 'lucide-react';
import type { Folder } from '../model';

type Props = {
  folders: Folder[];
  counts: Map<string, number>;
  total: number;
  trashCount: number;
  current: string | null;
  trash: boolean;
  withDescendants: boolean;
  onPick: (id: string | null) => void;
  onTrash: () => void;
  onDescendants: (v: boolean) => void;
};

/** Folders are the artist's places; one picture may be in several (Q74). Counts are per picture. */
export function FolderPane(p: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const children = (parent: string | null) => p.folders.filter((f) => f.parent === parent);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const row = (f: Folder, depth: number): React.ReactNode => {
    const kids = children(f.id);
    const isOpen = !collapsed.has(f.id);
    return <li key={f.id}>
      <div className={`tree-row${p.current === f.id && !p.trash ? ' is-current' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
        {kids.length ? <button className="twisty" aria-label={isOpen ? '收起' : '展开'} aria-expanded={isOpen} onClick={() => toggle(f.id)}><ChevronRight size={12} className={isOpen ? 'rot' : ''} /></button> : <span className="twisty" />}
        <button className="tree-label" onClick={() => p.onPick(f.id)} aria-current={p.current === f.id && !p.trash}>
          <FolderIcon size={14} /><span>{f.name}</span><span className="count tabular">{p.counts.get(f.id) ?? 0}</span>
        </button>
      </div>
      {kids.length > 0 && isOpen && <ul>{kids.map((k) => row(k, depth + 1))}</ul>}
    </li>;
  };
  return <nav className="pane-body folders" aria-label="文件夹">
    <div className={`tree-row root${p.current === null && !p.trash ? ' is-current' : ''}`}>
      <button className="tree-label" onClick={() => p.onPick(null)}><Images size={14} /><span>全部图片</span><span className="count tabular">{p.total}</span></button>
    </div>
    <ul className="tree">{children(null).map((f) => row(f, 0))}</ul>
    <label className="check"><input type="checkbox" checked={p.withDescendants} onChange={(e) => p.onDescendants(e.target.checked)} />包含子文件夹</label>
    <div className="pane-foot">
      <div className="tree-row muted-row" title="保存的检索，按条件实时计算成员（roadmap）">
        <span className="tree-label disabled"><FolderSearch size={14} /><span>智能文件夹</span><span className="tag-soon">规划中</span></span>
      </div>
      <div className={`tree-row${p.trash ? ' is-current' : ''}`}>
        <button className="tree-label" onClick={p.onTrash}><Trash2 size={14} /><span>回收站</span><span className="count tabular">{p.trashCount}</span></button>
      </div>
    </div>
  </nav>;
}
