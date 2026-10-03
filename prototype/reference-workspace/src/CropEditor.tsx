import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, Crop as CropIcon, Image, Plus, X, ZoomIn } from 'lucide-react';
import type { Crop, Folder, Picture } from './data';
import { folderPath, whole } from './data';

export function CropPicture({ picture, crop, className = '' }: { picture: Picture; crop: Crop; className?: string }) {
  const style: CSSProperties = { aspectRatio: `${picture.width * crop.w} / ${picture.height * crop.h}` };
  return <div className={`crop-picture ${className} ${picture.tags.includes('透明') ? 'alpha-ground' : ''}`} style={style}>
    <img src={picture.url} alt={picture.title} draggable={false} style={{ width: `${100 / crop.w}%`, left: `${-crop.x * 100 / crop.w}%`, top: `${-crop.y * 100 / crop.h}%` }} />
  </div>;
}

export default function CropEditor({ picture, folders, onBack, onAdd, onFolders, onTags }: {
  picture: Picture; folders: Folder[]; onBack: () => void;
  onAdd: (crop: Crop, useNow: boolean) => void; onFolders: (ids: string[]) => void; onTags: (tags: string[]) => void;
}) {
  const [mode, setMode] = useState<'whole' | 'crop'>('whole');
  const [crop, setCrop] = useState<Crop>({ x: .2, y: .2, w: .6, h: .6 });
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tagText, setTagText] = useState('');
  const [box, setBox] = useState({ width: 700, height: 520 });
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBox({ width: Math.max(1, element.clientWidth - 32), height: Math.max(1, element.clientHeight - 32) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = actual ? 1 : Math.min(box.width / picture.width, box.height / picture.height, 1);
  const selected = mode === 'whole' ? whole : crop;
  const size = `${Math.round(picture.width * selected.w)} × ${Math.round(picture.height * selected.h)}`;
  const location = (clientX: number, clientY: number) => {
    const rect = imageRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) };
  };
  const setPercent = (key: keyof Crop, value: number) => {
    if (!Number.isFinite(value)) return;
    setCrop(previous => {
      const next = { ...previous, [key]: Math.max(key === 'w' || key === 'h' ? .03 : 0, Math.min(1, value / 100)) };
      next.x = Math.min(next.x, 1 - next.w); next.y = Math.min(next.y, 1 - next.h);
      return next;
    });
  };
  return <section className="crop-editor" aria-label="取出整图或局部参考">
    <div className="crop-toolbar"><button onClick={onBack}><ArrowLeft size={16} />返回找图</button><span>{picture.width} × {picture.height}</span><button aria-pressed={actual} onClick={() => setActual(value => !value)}><ZoomIn size={16} />{actual ? '适应窗口' : '1:1 查看'}</button></div>
    <div className="crop-stage" ref={stageRef}>
      <div className="crop-center" style={{ minWidth: picture.width * scale + 32, minHeight: picture.height * scale + 32 }}>
        <div className={`crop-source ${mode === 'crop' ? 'can-crop' : ''}`} ref={imageRef} style={{ width: picture.width * scale, height: picture.height * scale }}
          onPointerDown={event => {
            if (mode !== 'crop' || event.button !== 0 || failed) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            start.current = { ...location(event.clientX, event.clientY), crop };
          }}
          onPointerMove={event => {
            if (!start.current) return;
            const point = location(event.clientX, event.clientY), origin = start.current;
            setCrop({ x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), w: Math.max(.001, Math.abs(point.x - origin.x)), h: Math.max(.001, Math.abs(point.y - origin.y)) });
          }}
          onPointerUp={event => {
            if (!start.current) return;
            if (crop.w < .03 || crop.h < .03) setCrop(start.current.crop);
            start.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { if (start.current) setCrop(start.current.crop); start.current = null; }}>
          <img className="source-image" src={picture.url} alt={picture.title} draggable={false} onError={() => setFailed(true)} />
          {failed ? <div className="crop-error"><p>无法读取图片</p><button onClick={onBack}>返回并选择另一张</button></div> : mode === 'crop' && <>
            <div className="crop-shade" />
            <div className="crop-selection" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}><CropPicture picture={picture} crop={crop} /><span className="crop-size">{size}</span></div>
          </>}
        </div>
      </div>
    </div>
    <aside className="take-panel">
      <div className="take-title"><h2>{picture.title}</h2><p>{picture.source}</p></div>
      <div className="take-choice" aria-label="参考范围"><button aria-pressed={mode === 'whole'} onClick={() => setMode('whole')}><Image size={18} />整图</button><button aria-pressed={mode === 'crop'} onClick={() => setMode('crop')}><CropIcon size={18} />取局部</button></div>
      <p className="take-instruction">{mode === 'crop' ? '在图上拖出需要的范围；也可以输入比例。' : '保持完整构图，原图不会被裁切。'}</p>
      {mode === 'crop' && <details className="precise-crop"><summary>精确范围</summary><div>{([['x', '左'], ['y', '上'], ['w', '宽'], ['h', '高']] as const).map(([key, label]) => <label key={key}>{label} %<input type="number" min={key === 'w' || key === 'h' ? 3 : 0} max={100} step={1} value={Math.round(crop[key] * 100)} onChange={event => setPercent(key, event.currentTarget.valueAsNumber)} /></label>)}</div></details>}
      <div className="take-preview"><CropPicture picture={picture} crop={selected} /><span>{mode === 'crop' ? '局部参考' : '整图参考'} · {size}</span></div>
      <div className="take-actions"><button className="primary-button" disabled={failed || selected.w < .03 || selected.h < .03} onClick={() => onAdd(selected, false)}><Plus size={18} />加入参考，继续找图</button><button disabled={failed || selected.w < .03 || selected.h < .03} onClick={() => onAdd(selected, true)}>加入后开始绘画</button></div>
      <details className="source-organization">
        <summary>整理这张原图</summary>
        <p>所属文件夹，可同时选择多个</p>
        <div className="folder-memberships">{folders.filter(folder => folder.libraryId === picture.libraryId).map(folder => <label key={folder.id}><input type="checkbox" checked={picture.folderIds.includes(folder.id)} onChange={() => onFolders(picture.folderIds.includes(folder.id) ? picture.folderIds.filter(id => id !== folder.id) : [...picture.folderIds, folder.id])} />{folderPath(folder.id, folders).join(' / ')}</label>)}</div>
        <div className="static-tags">{picture.tags.map(tag => <button key={tag} aria-label={`移除标签 ${tag}`} onClick={() => onTags(picture.tags.filter(item => item !== tag))}>{tag}<X size={12} /></button>)}{!picture.tags.length && <span>还没有标签</span>}</div>
        <form className="add-tag" onSubmit={event => {
          event.preventDefault();
          const tags = tagText.split(/[,，\s]+/).filter(Boolean);
          if (tags.length) { onTags([...new Set([...picture.tags, ...tags])]); setTagText(''); }
        }}><input aria-label="新增原图标签" placeholder="添加标签" value={tagText} onChange={event => setTagText(event.target.value)} /><button disabled={!tagText.trim()} aria-label="添加原图标签" type="submit"><Plus size={15} /></button></form>
      </details>
    </aside>
  </section>;
}
