import { useState } from 'react';
import { BookmarkPlus, Clipboard, FolderOpen, ImageOff, Layers, Pin, Trash2 } from 'lucide-react';
import type { Capture, Crop, ReferenceGroup, ReferenceImage } from '../model';

/** A crop drawn from the view file, without canvas: file:// images cannot be read back. */
export function ViewThumb({ image, crop, box, veiled }: { image?: ReferenceImage; crop: Crop | null; box: number; veiled?: boolean }) {
  if (!image) return <span className="vthumb missing" style={{ width: box, height: box }}><ImageOff size={14} /></span>;
  const c = crop ?? { x: 0, y: 0, w: image.w, h: image.h };
  const s = box / Math.max(c.w, c.h);
  return <span className={`vthumb${veiled ? ' is-veiled' : ''}`} style={{ width: c.w * s, height: c.h * s }}>
    <img src={crop ? image.view : image.thumb} alt="" draggable={false} style={{ width: image.w * s, height: image.h * s, transform: `translate(${-c.x * s}px, ${-c.y * s}px)` }} />
  </span>;
}

function relative(t: number) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

type GroupsProps = {
  groups: ReferenceGroup[];
  pinCount: number;
  resolve: (libraryId: string, imageId: string) => ReferenceImage | undefined;
  libraryName: (id: string) => string;
  isHidden: (image: ReferenceImage) => boolean;
  onSave: () => void;
  onOpen: (group: ReferenceGroup) => void;
  onRename: (group: ReferenceGroup, name: string) => void;
  onDelete: (group: ReferenceGroup) => void;
};

/** Reference groups live outside libraries and may draw on several (ADR-0002). */
export function GroupsPane(p: GroupsProps) {
  const [editing, setEditing] = useState<string | null>(null);
  return <div className="pane-body">
    <button className="primary block" disabled={!p.pinCount} onClick={p.onSave}><BookmarkPlus size={15} />把当前 {p.pinCount} 张钉图存为参考组</button>
    {!p.groups.length && <p className="pane-empty">还没有参考组。钉住几处局部后存成组，下次打开即可恢复摆放、大小、翻转与旋转。</p>}
    <ul className="group-list">
      {p.groups.map((g) => {
        const libs = [...new Set(g.members.map((m) => m.view.libraryId))].map(p.libraryName);
        return <li key={g.id} className="group-card">
          <div className="group-thumbs">
            {g.members.slice(0, 5).map((m, i) => {
              const img = p.resolve(m.view.libraryId, m.view.imageId);
              return <ViewThumb key={i} image={img} crop={m.view.crop} box={44} veiled={img ? p.isHidden(img) : false} />;
            })}
          </div>
          {editing === g.id
            ? <input className="rename" autoFocus defaultValue={g.name} onBlur={(e) => { p.onRename(g, e.target.value.trim() || g.name); setEditing(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} aria-label="参考组名称" />
            : <button className="group-name" onDoubleClick={() => setEditing(g.id)} onClick={() => p.onOpen(g)} title="打开（双击改名）">{g.name}</button>}
          <p className="muted small">{g.members.length} 个成员 · {libs.join(' + ')} · {relative(g.savedAt)}</p>
          <div className="row-actions">
            <button className="tool small" onClick={() => p.onOpen(g)}><Layers size={13} />打开</button>
            <button className="tool small" onClick={() => setEditing(g.id)}>改名</button>
            <button className="tool small danger" onClick={() => p.onDelete(g)}><Trash2 size={13} />删除</button>
          </div>
        </li>;
      })}
    </ul>
  </div>;
}

type CapturesProps = {
  captures: Capture[];
  pinnedIds: Set<string>;
  onPaste: () => void;
  onPin: (c: Capture) => void;
  onCollect: (c: Capture) => void;
  onDelete: (c: Capture) => void;
  onShow: (c: Capture) => void;
};

/** 截图历史: recent captures; ones neither collected nor pinned roll off after ten. */
export function CapturesPane(p: CapturesProps) {
  return <div className="pane-body">
    <button className="tool block" onClick={p.onPaste}><Clipboard size={15} />钉住剪贴板图片 <kbd>F3</kbd></button>
    <p className="pane-note">正式版用 F1 截取屏幕任意区域；网页无法截屏，这里用剪贴板图片（Ctrl+V 也可以）代替。最近 10 张，未收藏也未钉住的旧截图会被丢弃。</p>
    {!p.captures.length && <p className="pane-empty">截图历史为空。复制一张网上的图片，回到这里按 Ctrl+V。</p>}
    <ul className="capture-list">
      {p.captures.map((c) => <li key={c.id}>
        <span className="cap-thumb"><img src={c.url} alt="" /></span>
        <div>
          <p>{c.label}</p>
          <p className="muted small tabular">{c.w} × {c.h} · {relative(c.at)}{p.pinnedIds.has(c.id) ? ' · 已钉住' : ''}{c.collectedAs ? ' · 已收藏' : ''}</p>
          <div className="row-actions">
            <button className="tool small" onClick={() => p.onPin(c)}><Pin size={13} />钉住</button>
            {c.collectedAs
              ? <button className="tool small" onClick={() => p.onShow(c)}><FolderOpen size={13} />在库中查看</button>
              : <button className="tool small" onClick={() => p.onCollect(c)}><BookmarkPlus size={13} />收藏</button>}
            <button className="tool small danger" onClick={() => p.onDelete(c)} aria-label="删除截图"><Trash2 size={13} /></button>
          </div>
        </div>
      </li>)}
    </ul>
  </div>;
}

