import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Ported from bd8aea44:prototype/reference-browser/src/components/Rail.tsx: the same lucide icons,
// logo path, indicator and dark number badges. The badge counts are the app's real ones.
import { History, Images, Layers, Settings } from 'lucide-react';
import { SealBook } from '../SealBook';
import { BrandMark } from '../ui/BrandMark';
import { captureHistory, onCaptureHistory, onReferenceGroupsChanged, referenceGroups } from '../ipc';

export type Section = 'browse' | 'groups' | 'captures';
type Props = {
  section: Section;
  paneOpen: boolean;
  safeMode: boolean;
  onSection: (s: Section) => void;
  onSafeMode: () => void;
  onSettings: () => void;
};

const ITEMS: { id: Section; icon: typeof Images; key: string }[] = [
  { id: 'browse', icon: Images, key: 'Ctrl+1' },
  { id: 'groups', icon: Layers, key: 'Ctrl+2' },
  { id: 'captures', icon: History, key: 'Ctrl+3' },
];

const count = (value: unknown) => (Array.isArray(value) && value.length > 0 ? value.length : undefined);

/** 参考组与截图历史的数量（原型的深色数字角标）；图片与文件夹没有角标。 */
function useBadges(): Partial<Record<Section, number>> {
  const [groups, setGroups] = useState<number>();
  const [captures, setCaptures] = useState<number>();
  useEffect(() => {
    let alive = true;
    const reloadGroups = () => referenceGroups().then((list) => alive && setGroups(count(list)), () => {});
    reloadGroups();
    captureHistory().then((list) => alive && setCaptures(count(list)), () => {});
    const stopGroups = onReferenceGroupsChanged(reloadGroups);
    const stopCaptures = onCaptureHistory((list) => alive && setCaptures(count(list)));
    return () => {
      alive = false;
      void stopGroups.then((stop) => stop(), () => {});
      void stopCaptures.then((stop) => stop(), () => {});
    };
  }, []);
  return { groups, captures };
}

/** The icon rail the brief asked for: names on hover and focus, the selection always visible,
 * an indicator that follows the selection (Axolotl's feedback, not its code). */
export function Rail(p: Props) {
  const { t } = useTranslation("shell");
  const nav = useRef<HTMLDivElement>(null);
  const badges = useBadges();
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(`[data-section="${p.section}"]`);
    if (el) setIndicator({ top: el.offsetTop + 8, height: el.offsetHeight - 16 });
  }, [p.section]);
  return <nav className="rail" aria-label={t("nav.label")}>
    <div className="brand" title="Kinshoko" data-tauri-drag-region="deep">
      <BrandMark size={28} />
    </div>
    <div className="rail-items" ref={nav}>
      {indicator && <span className="rail-indicator" style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }} aria-hidden="true" />}
      {ITEMS.map(({ id, icon: Icon, key }) => { const label = t(`nav.${id}`); return <button key={id} data-section={id} type="button"
        className={`rail-btn${p.section === id ? ' is-active' : ''}`} aria-current={p.section === id ? 'page' : undefined}
        aria-label={label} aria-expanded={p.section === id ? p.paneOpen : undefined} onClick={() => p.onSection(id)}>
        <Icon size={20} strokeWidth={1.75} />
        {!!badges[id] && <span className="rail-badge tabular">{badges[id]}</span>}
        <span className="tip" role="tooltip">{label}<kbd>{key}</kbd></span>
      </button>; })}
    </div>
    <div className="rail-foot">
      <SealBook on={p.safeMode} onToggle={p.onSafeMode} />
      <button type="button" className="rail-btn" aria-label={t("nav.settings")} onClick={p.onSettings}>
        <Settings size={20} strokeWidth={1.75} />
        <span className="tip" role="tooltip">{t("nav.settingsTip")}</span>
      </button>
    </div>
  </nav>;
}
