import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, Info, Maximize, Minus, Plus, X } from 'lucide-react';
import type { Picture } from './data';

type Props = { picture?: Picture; overlay?: boolean; modal?: boolean; onClose?: () => void; onStep: (direction: number) => void; onRemove: () => void; onFiles: () => void; };
export default function Viewer({ picture, overlay = false, modal = overlay, onClose, onStep, onRemove, onFiles }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLElement>(null);
  useEffect(() => { if (modal) viewerRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); }, [modal]);
  const [space, setSpace] = useState({ width: 700, height: 600 });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [info, setInfo] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setZoom('fit'); setFailed(false); stageRef.current?.scrollTo(0, 0); }, [picture?.id]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setSpace({ width: stage.clientWidth, height: stage.clientHeight }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [picture?.id]);
  const fit = picture ? Math.min(1, (space.width - 40) / picture.width, (space.height - 40) / picture.height) : 1;
  const scale = zoom === 'fit' ? Math.max(0.01, fit) : zoom;
  const adjust = (delta: number) => setZoom(Math.max(0.05, Math.min(8, scale + delta)));
  return <section ref={viewerRef} role={modal ? 'dialog' : undefined} aria-modal={modal || undefined} className={`viewer ${overlay ? 'viewer-overlay' : ''}`} aria-label="原图查看"
    onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === 'Escape' && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab' && modal) {
        const controls = Array.from(viewerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"], a[href]') ?? []);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus({ preventScroll: true }); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus({ preventScroll: true }); }
      }
      if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); onStep(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); onStep(1); }
      if (event.key === '+' || event.key === '=') adjust(0.25);
      if (event.key === '-') adjust(-0.25);
    }}>
    <div className="viewer-toolbar">
      {onClose && <button className="icon-button" aria-label={modal ? '返回浏览位置' : '收起详情'} onClick={onClose}>
        {overlay ? <ArrowLeft size={18} /> : <X size={18} />}
      </button>}
      <span className="viewer-title">{picture?.title ?? '选一张图，开始观察'}</span>
      {picture && <div className="viewer-tools">
        <button className={`text-button ${zoom === 'fit' ? 'is-active' : ''}`} onClick={() => setZoom('fit')} aria-label="适应查看区域"><Maximize size={15} /><span>适应</span></button>
        <button className={`text-button ${zoom === 1 ? 'is-active' : ''}`} onClick={() => setZoom(1)} aria-label="原始尺寸，一个图像像素对应一个 CSS 像素">原始尺寸（CSS）</button>
        <button className="icon-button compact" onClick={() => adjust(-0.25)} aria-label="缩小"><Minus size={16} /></button>
        <span className="zoom-value">{Math.round(scale * 100)}%</span>
        <button className="icon-button compact" onClick={() => adjust(0.25)} aria-label="放大"><Plus size={16} /></button>
        <button className="icon-button compact" aria-label="图片信息" aria-expanded={info} onClick={() => setInfo((value) => !value)}><Info size={16} /></button>
      </div>}
    </div>
    <div className="viewer-stage" ref={stageRef} tabIndex={0} aria-label="图片观察区域，可用左右键切换">
      {!picture ? <div className="observation-empty"><Maximize size={28} /><h2>把目光留在参考上</h2><p>从右侧选图。这里保留大图，<br />结果列表可以继续浏览。</p></div> :
        failed ? <div className="observation-empty"><AlertCircle size={28} /><h2>这张图片无法读取</h2><p>浏览器未能解码，其他图片仍可查看。</p><button className="primary-button" onClick={onFiles}>重新选择本地图片</button><button className="text-button" onClick={onRemove}>从本次结果移除</button></div> :
          <div className="viewer-canvas"><img src={picture.url} className={picture.tags.includes('透明') ? 'alpha-ground' : ''} alt={picture.title}
            style={{ width: picture.width * scale, height: picture.height * scale }} draggable={false} onError={() => setFailed(true)} /></div>}
    </div>
    {picture && <div className="viewer-footer"><button className="icon-button compact" aria-label="上一张参考图" onClick={() => onStep(-1)}><ChevronLeft size={17} /></button><span>{picture.width} × {picture.height}<span className="footer-note">浏览器显示尺寸</span></span><button className="icon-button compact" aria-label="下一张参考图" onClick={() => onStep(1)}><ChevronRight size={17} /></button></div>}
    {picture && info && <aside className="picture-information"><strong>{picture.title}</strong><p>{picture.source}</p><dl><dt>图片 ID</dt><dd>{picture.id}</dd><dt>尺寸</dt><dd>{picture.width} × {picture.height}</dd><dt>标签</dt><dd>{picture.tags.join('、') || '未标注'}</dd></dl><p className="subtle">样本标签手工构造；没有运行自动打标。原始尺寸为一图像像素对应一 CSS 像素，原生 DPI 与色彩另行验证。</p><button className="text-button danger" onClick={onRemove}>从本次结果移除</button></aside>}
  </section>;
}
