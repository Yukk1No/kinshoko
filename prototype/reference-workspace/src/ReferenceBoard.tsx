import { useEffect, useRef, useState } from 'react';
import { GripHorizontal, ImagePlus, Lock, Minus, Plus, X, Unlock, Save } from 'lucide-react';
import type { Picture, Reference } from './data';
import { CropPicture } from './CropEditor';

export default function ReferenceBoard({ members, pictures, name, onChange, onSave, onFind, compact = false }: {
  members: Reference[]; pictures: Picture[]; name: string; onChange: (members: Reference[]) => void;
  onSave: () => void; onFind: () => void; compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 700, height: 600 });
  const [active, setActive] = useState('');
  const drag = useRef<{ id: string; clientX: number; clientY: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const update = (id: string, patch: Partial<Reference>) => onChange(members.map(member => member.id === id ? { ...member, ...patch } : member));
  // Keep DOM nodes in stable identity order; the saved member order controls layers.
  const windowOrder = [...members].sort((a, b) => a.id.localeCompare(b.id));
  return <section className={`reference-board ${compact ? 'compact-board' : ''}`} aria-label="绘画参考区">
    <header className="board-header"><div><h2>{name || '这次绘画'}</h2><span>{members.length} 个参考 · 网页内模拟桌面置顶</span></div><button onClick={onSave} disabled={!members.length} aria-label="保存参考组"><Save size={17} />{!compact && '保存参考组'}</button></header>
    <div className="board-canvas" ref={ref}>
      {!members.length && <div className="board-empty"><ImagePlus size={30} /><h3>把用得上的参考放在这里</h3><p>整图或局部都可以。<br />摆好后保存成参考组，下次直接打开。</p><button onClick={onFind}>去找一张图</button></div>}
      {windowOrder.map(member => {
        const index = members.findIndex(item => item.id === member.id);
        const picture = pictures.find(image => image.libraryId === member.libraryId && image.id === member.imageId);
        if (!picture) return <div className="missing-reference" key={member.id}><p>来源图片暂时不可用，参考仍保留。</p><button onClick={() => onChange(members.filter(item => item.id !== member.id))}>移除此参考</button></div>;
        const width = Math.min(Math.max(130, box.width * member.width), Math.max(130, Math.min(340, box.width - 16)));
        const imageHeight = Math.min(260, width * picture.height * member.crop.h / (picture.width * member.crop.w));
        const height = imageHeight + 68;
        const travelX = Math.max(1, box.width - width - 8), travelY = Math.max(1, box.height - height - 8);
        return <article className={`reference-window ${member.locked ? 'is-locked' : ''} ${active === member.id ? 'is-active' : ''}`} key={member.id}
          style={{ width, left: 4 + member.x * travelX, top: 4 + member.y * travelY, zIndex: index + 1 }} onPointerDown={() => {
            setActive(member.id);
            if (index !== members.length - 1) onChange([...members.filter(item => item.id !== member.id), member]);
          }}>
          <div className="window-header"><button className="move-handle" disabled={member.locked} title="拖动，或用方向键移动" aria-label={`移动参考 ${picture.title}`}
            onPointerDown={event => {
              if (member.locked || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: member.id, clientX: event.clientX, clientY: event.clientY, x: member.x, y: member.y };
            }} onPointerMove={event => {
              const start = drag.current;
              if (start?.id === member.id) update(member.id, { x: clamp(start.x + (event.clientX - start.clientX) / travelX), y: clamp(start.y + (event.clientY - start.clientY) / travelY) });
            }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
            onKeyDown={event => {
              const deltas: Record<string, [number, number]> = { ArrowLeft: [-.04, 0], ArrowRight: [.04, 0], ArrowUp: [0, -.04], ArrowDown: [0, .04] };
              if (deltas[event.key]) { event.preventDefault(); event.stopPropagation(); update(member.id, { x: clamp(member.x + deltas[event.key][0]), y: clamp(member.y + deltas[event.key][1]) }); }
            }}><GripHorizontal size={16} /><span>{picture.title}</span></button><button className="window-icon" aria-label={`移除参考 ${picture.title}`} onClick={() => onChange(members.filter(item => item.id !== member.id))}><X size={14} /></button></div>
          <div className="window-image" style={{ height: imageHeight }}><div style={{ width: Math.min(width, imageHeight * picture.width * member.crop.w / (picture.height * member.crop.h)) }}><CropPicture picture={picture} crop={member.crop} /></div></div>
          <footer className="window-footer"><span>{member.crop.w === 1 && member.crop.h === 1 ? '整图' : '局部'} · {member.locked ? '位置已锁定' : '可移动'}</span><button className="window-icon" disabled={member.width <= .18} aria-label={`缩小参考 ${picture.title}`} onClick={() => update(member.id, { width: Math.max(.18, member.width - .04) })}><Minus size={14} /></button><button className="window-icon" disabled={member.width >= .7} aria-label={`放大参考 ${picture.title}`} onClick={() => update(member.id, { width: Math.min(.7, member.width + .04) })}><Plus size={14} /></button><button className="window-icon" aria-pressed={member.locked} aria-label={`${member.locked ? '解锁' : '锁定'}参考位置 ${picture.title}`} onClick={() => update(member.id, { locked: !member.locked })}>{member.locked ? <Lock size={14} /> : <Unlock size={14} />}</button></footer>
        </article>;
      })}
    </div>
    {!compact && <footer className="board-help"><span>拖动标题摆放，锁定位置后安心画。局部范围在找图时选好。</span><button onClick={onFind}>继续找图</button></footer>}
  </section>;
}
