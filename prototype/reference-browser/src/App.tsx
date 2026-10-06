import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftToLine, BookmarkPlus, Brush, ChevronDown, PanelLeft, PanelLeftClose, PinOff } from 'lucide-react';
import { Rail, type Section } from './components/Rail';
import { SearchBox, type SearchHandle } from './components/SearchBox';
import { TagGroupBar } from './components/TagGroupBar';
import { FolderPane } from './components/FolderPane';
import { Wall, type WallHandle, type WallStats } from './components/Wall';
import { Viewer } from './components/Viewer';
import { InfoPanel } from './components/InfoPanel';
import { PinLayer } from './components/PinLayer';
import { CapturesPane, GroupsPane, ViewThumb } from './components/Panes';
import { Dialog, Menu, Toasts, type MenuItem, type Toast } from './components/Overlays';
import { DrawingCanvas } from './components/DrawingCanvas';
import { DensitySlider } from './components/DensitySlider';
import { SettingsDialog, HelpDialog, type Settings } from './components/SettingsDialog';
import {
  emptyCuration, effectiveRating, imageKey, isAdult, isTyping, uid,
  type Capture, type Crop, type Curation, type Library, type Pin, type Rating, type ReferenceGroup, type ReferenceImage, type TagDef, type TagKey,
} from './model';
import { countTags, descendants, indexImages, runSearch, termLabel, type Condition, type Scope, type Term } from './search';
import { TAG_GROUPS, dictionary, inflate, seedInfo, seedLibraries } from './seed';
import { usePersistent, resetPersistent } from './persist';
import { exportLog, hashOf, log, setLogging } from './log';
import { RELEASE, SEAL, SealFx, type FxReport } from './sealfx';

const DEFAULT_SETTINGS: Settings = { theme: 'system', reducedMotion: false, density: 240, capTall: true, showTitles: false, square: false, inflate: false, logging: false, stats: false, releaseInput: 'allow', fxSlow: false };
const systemReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// The side pane slides on the wall's resize curve, so its edge and the cards beside it move in step.
const PANE = { w: 248, ms: 240, ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
type DialogState =
  | { kind: 'save-group' }
  | { kind: 'open-group'; group: ReferenceGroup }
  | { kind: 'collect'; capture: Capture }
  | { kind: 'delete-group'; group: ReferenceGroup }
  | { kind: 'settings' }
  | { kind: 'help' }
  | null;

const now = () => new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function App() {
  const seed = useMemo(seedLibraries, []);
  const [storedSettings, setSettings] = usePersistent<Settings>('settings', DEFAULT_SETTINGS);
  // Settings saved by an older build may lack newer fields.
  const settings: Settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const [libraryId, setLibraryId] = usePersistent('library', seed[0].id);
  const [curation, setCuration] = usePersistent<Curation>('curation', emptyCuration);
  const [groups, setGroups] = usePersistent<ReferenceGroup[]>('groups', []);
  // Captures live in memory in this prototype, so pins of them do not survive a reload.
  const [pins, setPins] = usePersistent<Pin[]>('pins', []);
  const [safeMode, setSafeMode] = usePersistent('safe-mode', true);
  const [paneOpen, setPaneOpen] = usePersistent('pane-open', true);
  const [paneMotion, setPaneMotion] = useState<'opening' | 'closing' | null>(null);
  /** The pane's width when a motion starts: the first frame draws it there, so the wall measures from it too. */
  const [paneStart, setPaneStart] = useState(0);
  const paneFrom = useRef<{ w: number; bars: Map<Element | 'lib', DOMRect> } | null>(null);
  const paneTimer = useRef(0);
  const [infoOpen, setInfoOpen] = usePersistent('info-open', true);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [collected, setCollected] = useState<Record<string, ReferenceImage[]>>({});
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [scope, setScope] = useState<Scope>({ folderId: null, withDescendants: true, trash: false });
  const [section, setSection] = useState<Section>('browse');
  const [viewing, setViewing] = useState<string | null>(null);
  const [edgeHidden, setEdgeHidden] = useState(false);
  const [canvasMode, setCanvasMode] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [libMenu, setLibMenu] = useState(false);
  const [stats, setStats] = useState<WallStats | null>(null);
  const wall = useRef<WallHandle>(null);
  const search = useRef<SearchHandle>(null);
  const lastViewed = useRef<string | null>(null);
  // Seal and release (#27): ghosts fly in a fixed layer; cards they fly to stay hidden until they land.
  const fxHost = useRef<HTMLDivElement>(null);
  const fx = useRef<SealFx | null>(null);
  const [arriving, setArriving] = useState<Set<string>>(() => new Set());
  const [releasing, setReleasing] = useState(false);
  const releaseTimer = useRef(0);
  const pendingRelease = useRef(false);
  const [fxReport, setFxReport] = useState<FxReport | null>(null);
  const reduced = settings.reducedMotion || systemReduced();
  const slow = settings.fxSlow ? 5 : 1;

  useEffect(() => { setPins((list) => list.filter((p) => p.source.kind === 'view')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLogging(settings.logging); }, [settings.logging]);
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', settings.theme);
    root.toggleAttribute('data-reduced-motion', settings.reducedMotion);
  }, [settings.theme, settings.reducedMotion]);

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // ------------------------------------------------------------ libraries and search
  const libraries: Library[] = useMemo(() => seed.map((l) => {
    const base = settings.inflate && l.id === seed[0].id ? inflate(l, 10_000) : l;
    return { ...base, images: [...[...(collected[l.id] ?? [])].reverse(), ...base.images] };
  }), [seed, settings.inflate, collected]);
  const library = libraries.find((l) => l.id === libraryId) ?? libraries[0];
  const dict: Record<TagKey, TagDef> = useMemo(() => {
    const extra = Object.fromEntries((curation.createdTags[library.id] ?? []).map((d) => [d.key, d]));
    return { ...dictionary, ...extra };
  }, [curation.createdTags, library.id]);
  const index = useMemo(() => indexImages(library.images, dict, curation), [library.images, dict, curation]);
  // Safe mode seals adult images out of the wall and search: results, counts and candidates only see the rest (Q97, Q101).
  const shownIndex = useMemo(() => (safeMode ? index.filter((e) => !isAdult(effectiveRating(e.image, curation))) : index), [index, safeMode, curation]);
  const liveIndex = useMemo(() => shownIndex.filter((e) => !(imageKey(e.image) in curation.trashed)), [shownIndex, curation.trashed]);
  const counts = useMemo(() => countTags(liveIndex), [liveIndex]);
  const results = useMemo(() => runSearch(shownIndex, conditions, scope, library.folders, curation), [shownIndex, conditions, scope, library.folders, curation]);
  // The group picker counts within the current results: what is left if this tag is added.
  const resultCounts = useMemo(() => {
    const ids = new Set(results.map((r) => r.id));
    return countTags(shownIndex.filter((e) => ids.has(e.image.id)));
  }, [shownIndex, results]);
  const resultKey = useMemo(() => JSON.stringify([library.id, conditions, scope, settings.inflate]), [library.id, conditions, scope, settings.inflate]);
  const folderCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of library.folders) {
      const set = scope.withDescendants ? descendants(library.folders, f.id) : new Set([f.id]);
      out.set(f.id, liveIndex.filter((e) => e.folders.some((x) => set.has(x))).length);
    }
    return out;
  }, [library.folders, liveIndex, scope.withDescendants]);
  const groupsForBar = useMemo(() => [
    ...TAG_GROUPS.map((label) => ({ label, tags: Object.values(dict).filter((d) => d.ns === '一般' && d.group === label) })),
    { label: '作品', tags: Object.values(dict).filter((d) => d.ns === '作品').sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0)) },
  ], [dict, counts]);

  useEffect(() => {
    if (conditions.length) log('search', { conditions: conditions.map((c) => ({ negate: c.negate, any: c.any.map((t) => termLabel(t, dict)) })), results: results.length });
  }, [conditions]); // eslint-disable-line react-hooks/exhaustive-deps

  const allImage = useCallback((libraryId: string, imageId: string) => libraries.find((l) => l.id === libraryId)?.images.find((i) => i.id === imageId), [libraries]);
  const isHidden = useCallback((image: ReferenceImage) => safeMode && isAdult(effectiveRating(image, curation)) && !revealed.has(imageKey(image)), [safeMode, curation, revealed]);
  const adult = (image: ReferenceImage) => isAdult(effectiveRating(image, curation));

  const addTerm = (term: Term, mode: 'and' | 'or', negate = false) => setConditions((list) => {
    const same = (t: Term) => (t.kind === 'tag' && term.kind === 'tag' && t.key === term.key) || (t.kind === 'text' && term.kind === 'text' && t.text === term.text);
    const existing = list.find((c) => c.any.some(same));
    if (existing) return list.map((c) => c === existing ? { ...c, negate } : c);
    if (mode === 'or' && list.length) {
      const last = list[list.length - 1];
      return [...list.slice(0, -1), { ...last, any: [...last.any, term] }];
    }
    return [...list, { id: uid('c'), any: [term], negate }];
  });
  /** Take one tag out of the conditions; a condition left with no alternatives goes too. */
  const removeTag = (key: TagKey) => setConditions((list) => list.flatMap((c) => {
    const any = c.any.filter((t) => !(t.kind === 'tag' && t.key === key));
    return any.length ? [{ ...c, any }] : [];
  }));
  const findTag = (key: TagKey) => {
    setViewing(null);
    setScope((s) => ({ ...s, folderId: null, trash: false }));
    setConditions([{ id: uid('c'), any: [{ kind: 'tag', key }], negate: false }]);
  };

  // ------------------------------------------------------------ curation (artist decisions)
  const decide = <K extends 'tags' | 'folders'>(field: K, image: ReferenceImage, key: string, value: string | null) => setCuration((c) => {
    const id = imageKey(image);
    const current = { ...(c[field][id] ?? {}) } as Record<string, string>;
    if (value === null) delete current[key]; else current[key] = value;
    return { ...c, [field]: { ...c[field], [id]: current } };
  });
  const setRating = (image: ReferenceImage, rating: Rating | null) => setCuration((c) => {
    const next = { ...c.rating };
    if (rating === null) delete next[imageKey(image)]; else next[imageKey(image)] = rating;
    return { ...c, rating: next };
  });
  const trash = (image: ReferenceImage, value: boolean) => {
    setCuration((c) => {
      const next = { ...c.trashed };
      if (value) next[imageKey(image)] = Date.now(); else delete next[imageKey(image)];
      return { ...c, trashed: next };
    });
    if (value) toast(`已移到回收站：${image.title}。它不再出现在普通查找中，已有参考组仍可使用。`, { label: '撤销', run: () => trash(image, false) });
  };

  // ------------------------------------------------------------ pins
  const placePin = (source: Pin['source'], x: number, y: number, scale: number) => {
    const pin: Pin = { id: uid('pin'), source, x, y, scale, flipH: false, flipV: false, rotate: 0, opacity: 1, locked: false };
    setPins((list) => [...list, pin]);
    setEdgeHidden(false);
    return pin;
  };
  const pinView = (image: ReferenceImage, crop: Crop | null, at?: { x: number; y: number }, scale?: number) => {
    const w = crop?.w ?? image.w, h = crop?.h ?? image.h;
    const s = scale ?? Math.min(1, 420 / Math.max(w, h));
    const x = at?.x ?? window.innerWidth - w * s - 40 - pins.length * 18;
    const y = at?.y ?? 80 + pins.length * 18;
    placePin({ kind: 'view', view: { libraryId: image.libraryId, imageId: image.id, crop } }, x, y, s);
    log('pin', { img: hashOf(image), crop: crop ? [crop.w, crop.h] : 'whole' });
  };
  const resolvePin = useCallback((pin: Pin) => {
    if (pin.source.kind === 'view') {
      const image = allImage(pin.source.view.libraryId, pin.source.view.imageId);
      return image ? { image } : { missing: true };
    }
    const id = pin.source.captureId;
    const capture = captures.find((c) => c.id === id);
    return capture ? { capture } : { missing: true };
  }, [allImage, captures]);
  const updatePin = (id: string, patch: Partial<Pin>) => setPins((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const closePin = (id: string) => setPins((list) => list.filter((p) => p.id !== id));
  const toFront = (id: string) => setPins((list) => {
    const i = list.findIndex((p) => p.id === id);
    return i < 0 || i === list.length - 1 ? list : [...list.slice(0, i), ...list.slice(i + 1), list[i]];
  });
  const toggleEdge = () => {
    if (!pins.length) return;
    setEdgeHidden((v) => !v);
    log('edge-hide', { hidden: !edgeHidden, pins: pins.length });
    // Focus goes back to the drawing surface (simulated canvas, or the page) so the next stroke lands there.
    (document.querySelector<HTMLElement>('.drawing-canvas') ?? document.body).focus?.();
  };

  // ------------------------------------------------------------ captures and collecting
  const addCapture = (url: string, w: number, h: number, label: string) => {
    const capture: Capture = { id: uid('cap'), url, w, h, at: Date.now(), label };
    setCaptures((list) => {
      const next = [capture, ...list];
      const pinned = new Set(pins.flatMap((p) => (p.source.kind === 'capture' ? [p.source.captureId] : [])));
      // Keep ten; drop the oldest that is neither collected nor pinned (glossary: 截图历史).
      while (next.length > 10) {
        const drop = [...next].reverse().find((c) => !c.collectedAs && !pinned.has(c.id) && c.id !== capture.id);
        if (!drop) break;
        next.splice(next.indexOf(drop), 1);
      }
      return next;
    });
    const s = Math.min(1, 420 / Math.max(w, h));
    placePin({ kind: 'capture', captureId: capture.id }, (window.innerWidth - w * s) / 2, (window.innerHeight - h * s) / 2, s);
    log('capture', { w, h });
  };
  const loadImage = (file: Blob) => new Promise<{ url: string; w: number; h: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
  const pasteClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) { const { url, w, h } = await loadImage(await item.getType(type)); addCapture(url, w, h, `剪贴板图片 ${now()}`); return; }
      }
      toast('剪贴板里没有图片。');
    } catch {
      toast('浏览器不允许直接读取剪贴板，请按 Ctrl+V。');
    }
  };
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (isTyping(e)) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      const { url, w, h } = await loadImage(file);
      addCapture(url, w, h, `剪贴板图片 ${now()}`);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });
  const newImage = (libraryId: string, url: string, w: number, h: number, title: string, folderId: string | null, from: string): ReferenceImage => ({
    id: uid('img'), libraryId, sha256: null, title, date: new Date().toISOString(), thumb: url, view: url, w, h, viewScale: 1, format: '—',
    sourceTags: [], autoTags: [], autoModel: null, rating: { value: 'general', from: `${from}（正式版收藏后自动分级，样稿未接入）` },
    sourceLinks: [], sourceFolders: folderId ? [folderId] : [], capturedAt: Date.now(),
  });
  const collectCapture = (capture: Capture, libraryId: string, folderId: string | null) => {
    const image = newImage(libraryId, capture.url, capture.w, capture.h, capture.label, folderId, '截图');
    setCollected((c) => ({ ...c, [libraryId]: [...(c[libraryId] ?? []), image] }));
    setCaptures((list) => list.map((c) => (c.id === capture.id ? { ...c, collectedAs: { libraryId, imageId: image.id } } : c)));
    // A collected capture is a reference image now: its pins keep showing it, by reference.
    setPins((list) => list.map((p) => (p.source.kind === 'capture' && p.source.captureId === capture.id ? { ...p, source: { kind: 'view', view: { libraryId, imageId: image.id, crop: null } } } : p)));
    log('collect', { w: capture.w, h: capture.h });
    return image;
  };
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      const added: ReferenceImage[] = [];
      for (const f of files) {
        try { const { url, w, h } = await loadImage(f); added.push(newImage(library.id, url, w, h, f.name.replace(/\.[^.]+$/, ''), scope.folderId, '拖放')); } catch { /* unsupported */ }
      }
      setCollected((c) => ({ ...c, [library.id]: [...(c[library.id] ?? []), ...added] }));
      toast(`已收藏 ${added.length} 张到「${library.name}」。样稿只在本次运行中保存，不复制、不上传文件。`);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  });

  // ------------------------------------------------------------ groups
  const openGroup = (group: ReferenceGroup, mode: 'replace' | 'add') => {
    const next: Pin[] = group.members.map((m) => ({ ...m, id: uid('pin'), source: { kind: 'view', view: m.view }, opacity: 1, locked: false }));
    setPins((list) => (mode === 'replace' ? next : [...list, ...next]));
    setEdgeHidden(false);
    log('group-open', { members: group.members.length, mode });
    toast(`已打开参考组「${group.name}」。`);
  };
  const requestOpenGroup = (group: ReferenceGroup) => (pins.length ? setDialog({ kind: 'open-group', group }) : openGroup(group, 'replace'));

  // ------------------------------------------------------------ viewer
  const viewed = viewing ? library.images.find((i) => i.id === viewing) ?? null : null;
  const openImage = (image: ReferenceImage) => {
    lastViewed.current = image.id;
    setViewing(image.id);
    log('open', { img: hashOf(image) });
  };
  const step = (delta: number) => {
    if (!viewed) return;
    const i = results.findIndex((r) => r.id === viewed.id);
    const next = results[(i < 0 ? 0 : i + delta + results.length) % results.length];
    if (next) openImage(next);
  };
  // ------------------------------------------------------------ seal and release (#27)
  useEffect(() => {
    const f = new SealFx(fxHost.current!);
    f.onReport = (r) => { log('seal-fx', r); setFxReport(r); };
    fx.current = f;
    return () => f.clear();
  }, []);
  useEffect(() => { if (fx.current) fx.current.slow = slow; }, [slow]);
  useEffect(() => { if (reduced) { fx.current?.clear(); wall.current?.finishReflow(); setArriving(new Set()); setReleasing(false); } }, [reduced]);
  const endRelease = () => { clearTimeout(releaseTimer.current); setReleasing(false); };
  const toggleSafeMode = () => {
    const next = !safeMode;
    log('safe-mode', { on: next });
    setRevealed(new Set());
    // Q103: the picture being viewed is sealed, so the viewer goes back to the wall.
    if (next && viewed && adult(viewed)) setViewing(null);
    const w = wall.current, book = document.querySelector('.seal-book')?.getBoundingClientRect();
    if (reduced || viewed || !w || !book) {
      // Q106 (and while the viewer covers the wall): sealed images vanish at once, released ones are simply there.
      fx.current?.clear(); setArriving(new Set()); endRelease();
      setSafeMode(next);
      return;
    }
    if (next) {
      // Seal first (Q111): whatever is still flying out turns back; cards on screen blur and fly in.
      const onScreen = new Set(w.onScreen());
      const before = w.prepareReflow({ delay: (SEAL.flyAt + 20) * slow, duration: 620 * slow });
      const sources = results.filter((i) => onScreen.has(i.id) && adult(i) && !arriving.has(i.id))
        .flatMap((i) => { const rect = before.get(i.id); return rect ? [{ id: i.id, src: i.thumb, rect }] : []; });
      fx.current!.seal(sources, book);
      setArriving(new Set());
      endRelease();
    } else {
      w.prepareReflow({ delay: 40 * slow, duration: 680 * slow });
      pendingRelease.current = true;
      setReleasing(true);
    }
    setSafeMode(next);
  };
  // The release continues once the wall has laid out the returned images: their cards are the targets.
  useLayoutEffect(() => {
    if (!pendingRelease.current) return;
    pendingRelease.current = false;
    const w = wall.current, book = document.querySelector('.seal-book')?.getBoundingClientRect();
    if (!w || !book) { endRelease(); return; }
    const byId = new Map(results.map((i) => [i.id, i]));
    const ids = w.onScreen().filter((id) => { const i = byId.get(id); return !!i && adult(i); });
    setArriving(new Set(ids));
    fx.current!.release(ids.flatMap((id) => {
      const r = w.rectOf(id);
      return r ? [{ id, src: byId.get(id)!.thumb, w: r.width, h: r.height, target: () => w.rectOf(id) }] : [];
    }), book, (id) => setArriving((s) => { const n = new Set(s); n.delete(id); return n; }));
    clearTimeout(releaseTimer.current);
    const total = Math.max(720, RELEASE.flyAt + ids.length * RELEASE.stagger + RELEASE.fly);
    releaseTimer.current = window.setTimeout(() => setReleasing(false), total * slow);
  }, [safeMode]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Q105 "可打断": any input on the wall during a release plays it to the end at once. */
  const interruptRelease = () => {
    if (!releasing || settings.releaseInput !== 'interrupt') return;
    fx.current?.finish(); wall.current?.finishReflow(); setArriving(new Set()); endRelease();
  };

  // ------------------------------------------------------------ side pane
  // The pane's width animates and everything right of it follows its edge in normal flow. The wall lays out
  // once at its final width (held for the duration) and its cards glide there on the same curve, so on screen
  // each card travels in a straight line from where it was. The top-bar items that the switch adds or removes
  // (the expand button, the library switcher) shift the rest of the bar, so those items glide too.
  const setPane = (open: boolean) => {
    if (open === paneOpen) return;
    clearTimeout(paneTimer.current);
    const pane = document.querySelector<HTMLElement>('.pane');
    if (reduced) { pane?.getAnimations().forEach((a) => a.cancel()); paneFrom.current = null; setPaneMotion(null); wall.current?.holdWidth(null); setPaneOpen(open); return; }
    // Measure everything where it is now (mid-motion included) before cancelling anything.
    const bars = new Map<Element | 'lib', DOMRect>();
    const moving = [...document.querySelectorAll('.topbar > *, .groupbar > *')];
    for (const el of moving) if (!el.classList.contains('lib-switch')) bars.set(el, el.getBoundingClientRect());
    const lib = document.querySelector('.lib-switch');
    if (lib) bars.set('lib', lib.querySelector('.lib-btn')!.getBoundingClientRect());
    const w = pane ? pane.getBoundingClientRect().width : 0;
    [pane, lib, ...moving].forEach((el) => el?.getAnimations().forEach((a) => a.cancel()));
    if (!matchMedia('(max-width: 820px)').matches) {
      wall.current?.prepareReflow({ delay: 0, duration: PANE.ms * slow, resize: true });
      wall.current?.holdWidth(w - (open ? PANE.w : 0));
    }
    paneFrom.current = { w, bars };
    setPaneStart(w);
    setPaneMotion(open ? 'opening' : 'closing');
    setPaneOpen(open);
    paneTimer.current = window.setTimeout(() => { setPaneMotion(null); wall.current?.holdWidth(null); }, PANE.ms * slow + 40);
  };
  useLayoutEffect(() => {
    const from = paneFrom.current;
    if (!from) return;
    paneFrom.current = null;
    const timing = { duration: PANE.ms * slow, easing: PANE.ease };
    document.querySelector('.pane')?.animate([{ width: `${from.w}px` }, { width: `${paneOpen ? PANE.w : 0}px` }], { ...timing, fill: 'forwards' });
    // The bar's container moves on the same curve, so an offset that decays on it lands each item in a straight line.
    for (const [el, old] of from.bars) {
      const node = el === 'lib' ? document.querySelector('.lib-switch .lib-btn') : el;
      if (!node?.isConnected) continue;
      const target = el === 'lib' ? node.closest('.lib-switch')! : node;
      const now = node.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) target.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], timing);
    }
  }, [paneOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Back on the wall, the last viewed picture is in view and focused (返回原位置).
    if (!viewing && lastViewed.current) {
      const id = lastViewed.current;
      requestAnimationFrame(() => wall.current?.reveal(id));
    }
  }, [viewing]);

  // ------------------------------------------------------------ menus
  const cardMenu = (image: ReferenceImage, x: number, y: number) => {
    const author = Object.keys(curation.tags[imageKey(image)] ?? {}).concat(image.sourceTags.map((t) => t.tag)).find((k) => k.startsWith('作者:'));
    const inTrash = imageKey(image) in curation.trashed;
    setMenu({ x, y, items: [
      { label: '查看', hint: 'Enter', onSelect: () => openImage(image) },
      { label: '钉住整图', hint: 'P', onSelect: () => pinView(image, null) },
      ...(author ? [{ label: `查找 ${dict[author]?.name ?? ''} 的全部图`, onSelect: () => findTag(author) } as MenuItem] : []),
      'sep',
      inTrash ? { label: '从回收站恢复', onSelect: () => trash(image, false) } : { label: '移到回收站', hint: 'Delete', danger: true, onSelect: () => trash(image, true) },
    ] });
  };
  const pinMenu = (pin: Pin, x: number, y: number) => {
    const src = resolvePin(pin);
    setMenu({ x, y, items: [
      { label: '水平翻转', hint: 'H', checked: pin.flipH, onSelect: () => updatePin(pin.id, { flipH: !pin.flipH }) },
      { label: '垂直翻转', hint: 'V', checked: pin.flipV, onSelect: () => updatePin(pin.id, { flipV: !pin.flipV }) },
      { label: '旋转 90°', hint: 'R', onSelect: () => updatePin(pin.id, { rotate: ((pin.rotate + 90) % 360) as Pin['rotate'] }) },
      { label: '透明度', hint: `${Math.round(pin.opacity * 100)}%`, slider: { value: pin.opacity, min: 0.15, max: 1, step: 0.05, onChange: (v) => updatePin(pin.id, { opacity: v }) } },
      { label: '锁定位置与大小', hint: 'L', checked: pin.locked, onSelect: () => updatePin(pin.id, { locked: !pin.locked }) },
      { label: '回到原图像素', hint: '双击', disabled: pin.locked, onSelect: () => updatePin(pin.id, { scale: 1 }) },
      'sep',
      pin.source.kind === 'capture'
        ? { label: '收藏到资料库…', disabled: !src.capture, onSelect: () => src.capture && setDialog({ kind: 'collect', capture: src.capture }) }
        : { label: '在资料库中查看', disabled: !src.image, onSelect: () => { if (src.image) { setLibraryId(src.image.libraryId); setScope((s) => ({ ...s, folderId: null, trash: false })); setConditions([]); openImage(src.image); } } },
      { label: '全部存为参考组…', onSelect: () => setDialog({ kind: 'save-group' }) },
      'sep',
      { label: '关闭这张钉图', hint: 'Esc', danger: true, onSelect: () => closePin(pin.id) },
    ] });
  };

  // ------------------------------------------------------------ global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTyping(e);
      if (e.key === 'F4') { e.preventDefault(); toggleEdge(); return; }
      if (e.key === 'F3') { e.preventDefault(); pasteClipboard(); return; }
      if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); toggleSafeMode(); return; }
      if (e.ctrlKey && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); const s = (['browse', 'groups', 'captures'] as Section[])[Number(e.key) - 1]; setSection(s); setPane(true); return; }
      if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); setPane(!paneOpen); return; }
      if (typing || dialog || menu) return;
      if (canvasMode && e.key === 'Escape') { setCanvasMode(false); return; }
      if (viewing) return;
      if (e.key === 'F1') { e.preventDefault(); toast('正式版中 F1 截取屏幕任意区域并钉住。网页不能截屏：打开一张图后按 F1 框选库内局部，或用 Ctrl+V 钉剪贴板图片。'); return; }
      if (e.key === '/') { e.preventDefault(); search.current?.focus(); return; }
      if (e.key === '?') { e.preventDefault(); setDialog({ kind: 'help' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------ render
  const pinnedCaptureIds = new Set(pins.flatMap((p) => (p.source.kind === 'capture' ? [p.source.captureId] : [])));
  const trashCount = Object.keys(curation.trashed).filter((k) => k.startsWith(library.id + '/')).length;
  const scopeLabel = scope.trash ? '回收站' : scope.folderId ? library.folders.find((f) => f.id === scope.folderId)?.name : null;
  // Q110 candidate A: the wall and the side panels ignore input while a release plays.
  const blockInput = releasing && settings.releaseInput === 'block';
  const visibleCount = (l: Library) => (safeMode ? l.images.filter((i) => !adult(i)).length : l.images.length);
  const viewerPosition = viewed ? (() => { const i = results.findIndex((r) => r.id === viewed.id); return i < 0 ? '不在当前结果中' : `${i + 1} / ${results.length}`; })() : '';

  const empty = seedInfo.missing && !library.images.length ? <div>
    <h2>还没有样本图片</h2>
    <p>样稿使用验收样本清单中的 pixiv 作品，图片不进仓库。先按清单下载并校验，再生成样稿资料库：</p>
    <pre>python scripts/samples/fetch_pixiv.py{'\n'}cd prototype/reference-browser{'\n'}npm run library</pre>
    <p>也可以把自己的图片拖进窗口，只在这次运行中显示。</p>
  </div> : scope.trash ? <div><h2>回收站是空的</h2><p>移到回收站的图片会出现在这里，可以恢复。</p></div>
    : <div>
      <h2>没有同时满足这些条件的图</h2>
      <p>{conditions.length ? '去掉一个条件，或把其中一个改成“任一”。' : '这个文件夹里没有图片。'}</p>
      {conditions.length > 0 && <button className="tool" onClick={() => setConditions((c) => c.slice(0, -1))}>去掉最后一个条件</button>}
    </div>;

  // One library switcher: it heads the folder pane while that is open, otherwise it sits in the top bar.
  const libInPane = paneOpen && section === 'browse';
  const libSwitch = (
    <div className="lib-switch">
      <button className="lib-btn" onClick={() => setLibMenu((v) => !v)} aria-expanded={libMenu} aria-haspopup="menu" aria-label={`资料库：${library.name}`} title="切换资料库">
        <strong>{library.name}</strong><ChevronDown size={14} />
      </button>
      {libMenu && <Menu x={(document.querySelector('.lib-btn')?.getBoundingClientRect().left ?? 0)} y={(document.querySelector('.lib-btn')?.getBoundingClientRect().bottom ?? 0) + 4}
        onClose={() => setLibMenu(false)} items={[
          ...libraries.map((l): MenuItem => ({ label: `${l.name}　${visibleCount(l)} 张`, checked: l.id === library.id, onSelect: () => { setLibraryId(l.id); setScope({ folderId: null, withDescendants: scope.withDescendants, trash: false }); setViewing(null); } })),
          'sep', { label: '新建、合并、导入 Eagle（不在本样稿范围）', disabled: true },
        ]} />}
    </div>
  );

  return <div className={`app${canvasMode ? ' is-canvas' : ''}`}>
    <Rail section={section} paneOpen={paneOpen} safeMode={safeMode} reducedMotion={reduced} slow={slow}
      badges={{ groups: groups.length || undefined, captures: captures.length || undefined }}
      onSection={(s) => { if (s === section) setPane(!paneOpen); else { setSection(s); setPane(true); } }}
      onSafeMode={toggleSafeMode}
      onSettings={() => setDialog({ kind: 'settings' })} />

    <div className={`workspace${paneMotion ? ` is-pane-moving is-pane-${paneMotion}` : ''}`}>
      {(paneOpen || paneMotion === 'closing') && <aside className="pane" style={paneMotion ? { width: paneStart } : undefined} inert={!!viewed || blockInput || !paneOpen || undefined} aria-label={section === 'browse' ? '文件夹' : section === 'groups' ? '参考组' : '截图历史'}>
        <header className="pane-head">{section === 'browse' ? (libInPane ? libSwitch : <span />) : <h2>{section === 'groups' ? '参考组' : '截图历史'}</h2>}
          <button className="icon-tool" onClick={() => setPane(false)} aria-label="收起侧栏" title="收起（Ctrl+B）"><PanelLeftClose size={16} /></button></header>
        {section === 'browse' && <FolderPane folders={library.folders} counts={folderCounts} total={liveIndex.length} trashCount={trashCount}
          current={scope.folderId} trash={scope.trash} withDescendants={scope.withDescendants}
          onPick={(id) => { setViewing(null); setScope((s) => ({ ...s, folderId: id, trash: false })); }}
          onTrash={() => { setViewing(null); setScope((s) => ({ ...s, folderId: null, trash: true })); }}
          onDescendants={(v) => setScope((s) => ({ ...s, withDescendants: v }))} />}
        {section === 'groups' && <GroupsPane groups={groups} pinCount={pins.length} resolve={allImage} isHidden={isHidden}
          libraryName={(id) => libraries.find((l) => l.id === id)?.name ?? '已移除的资料库'}
          onSave={() => setDialog({ kind: 'save-group' })} onOpen={requestOpenGroup}
          onRename={(g, name) => setGroups((list) => list.map((x) => (x.id === g.id ? { ...x, name } : x)))}
          onDelete={(g) => setDialog({ kind: 'delete-group', group: g })} />}
        {section === 'captures' && <CapturesPane captures={captures} pinnedIds={pinnedCaptureIds} onPaste={pasteClipboard}
          onPin={(c) => { const s = Math.min(1, 420 / Math.max(c.w, c.h)); placePin(c.collectedAs ? { kind: 'view', view: { ...c.collectedAs, crop: null } } : { kind: 'capture', captureId: c.id }, (innerWidth - c.w * s) / 2, (innerHeight - c.h * s) / 2, s); }}
          onCollect={(c) => setDialog({ kind: 'collect', capture: c })}
          onDelete={(c) => { setCaptures((l) => l.filter((x) => x.id !== c.id)); setPins((l) => l.filter((p) => !(p.source.kind === 'capture' && p.source.captureId === c.id))); }}
          onShow={(c) => { if (!c.collectedAs) return; const img = allImage(c.collectedAs.libraryId, c.collectedAs.imageId); if (img) { setLibraryId(img.libraryId); openImage(img); } }} />}
      </aside>}

      <main className="main" inert={!!viewed || blockInput || undefined} onPointerDownCapture={interruptRelease} onWheelCapture={interruptRelease} onKeyDownCapture={interruptRelease}>
        <header className="topbar">
          {!paneOpen && <button className="icon-tool" onClick={() => setPane(true)} aria-label="展开侧栏" title="展开（Ctrl+B）"><PanelLeft size={16} /></button>}
          {!libInPane && libSwitch}
          <SearchBox ref={search} conditions={conditions} dict={dict} counts={counts}
            onAdd={(t, mode) => { setViewing(null); addTerm(t, mode); }}
            onToggleNegate={(id) => setConditions((l) => l.map((c) => (c.id === id ? { ...c, negate: !c.negate } : c)))}
            onRemove={(id, term) => setConditions((l) => l.flatMap((c) => c.id !== id ? [c] : term === undefined ? [] : [{ ...c, any: c.any.filter((_, i) => i !== term) }]))}
            onClear={() => setConditions([])} />
          <span className="result-count tabular" aria-live="polite">{scopeLabel && <span className="muted">{scopeLabel} · </span>}{results.length} 张</span>
          <label className="density" title="图片大小">
            <span className="sr-only">图片大小</span>
            <DensitySlider value={settings.density} onPreview={(v) => wall.current?.previewDensity(v)} onCommit={(v) => setSettings((s) => ({ ...s, density: v }))} />
          </label>
        </header>
        <TagGroupBar groups={groupsForBar} counts={resultCounts} conditions={conditions} onAdd={(t, mode, negate) => { setViewing(null); addTerm(t, mode, negate); }}
          onRemove={(key) => { setViewing(null); removeTag(key); }} />
        <div className="content">
          <Wall ref={wall} images={results} resultKey={resultKey} density={settings.density} capTall={settings.capTall} showTitles={settings.showTitles} square={settings.square}
            isHidden={isHidden} onOpen={openImage} onMenu={cardMenu} empty={empty} onStats={settings.stats ? setStats : undefined} arriving={arriving}
            onKey={(image, e) => {
              if (e.key === 'p' || e.key === 'P') { pinView(image, null); return true; }
              if (e.key === 'Delete') { if (imageKey(image) in curation.trashed) trash(image, false); else trash(image, true); return true; }
              return false;
            }} />
          {stats && settings.stats && <div className="stats tabular">{stats.total} 张 · {stats.columns} 列 · 挂载 {stats.mounted} 张卡片
            {fxReport && <><br />{fxReport.kind === 'seal' ? '封印' : '释放'} {fxReport.ms} ms · {fxReport.ghosts} 张飞行 · {Math.round(fxReport.frames / (fxReport.ms / 1000))} fps · 最长一帧 {fxReport.worstFrame} ms</>}</div>}
        </div>
      </main>
      {viewed && <Viewer image={viewed} position={viewerPosition} hidden={isHidden(viewed)} infoOpen={infoOpen}
        onReveal={() => setRevealed((s) => new Set(s).add(imageKey(viewed)))}
        onToggleInfo={() => setInfoOpen((v) => !v)} onClose={() => setViewing(null)} onStep={step}
        onPin={(crop, at, scale) => pinView(viewed, crop, at, scale)}
        info={<InfoPanel image={viewed} library={library} dict={dict} counts={counts} curation={curation} hasPredictions={seedInfo.hasPredictions}
          onTag={(key, d) => { decide('tags', viewed, key, d); log('tag-decision', { img: hashOf(viewed), decision: d ?? 'undo' }); }}
          onCreateTag={(name) => {
            const key = `一般:${name}`;
            if (!dict[key]) setCuration((c) => ({ ...c, createdTags: { ...c.createdTags, [library.id]: [...(c.createdTags[library.id] ?? []), { key, ns: '一般', name, group: null, aliases: [] }] } }));
            decide('tags', viewed, key, 'add');
          }}
          onRating={(r) => setRating(viewed, r)} onFolder={(f, d) => decide('folders', viewed, f, d)}
          onNote={(note) => setCuration((c) => ({ ...c, notes: { ...c.notes, [imageKey(viewed)]: note } }))}
          onFind={findTag} />} />}
    </div>

    {canvasMode && <DrawingCanvas onExit={() => setCanvasMode(false)} />}
    <PinLayer pins={pins} edgeHidden={edgeHidden} resolve={resolvePin} isHidden={isHidden} reducedMotion={reduced}
      onChange={updatePin} onFront={toFront} onMenu={pinMenu} onClose={closePin} />

    {pins.length > 0 && <div className={`dock${edgeHidden ? ' is-edge' : ''}`} role="toolbar" aria-label="本次钉图">
      <span className="dock-count tabular">钉图 {pins.length}</span>
      <button className={`tool small${edgeHidden ? ' is-on' : ''}`} onClick={toggleEdge}><ArrowLeftToLine size={14} />{edgeHidden ? '回到原位' : '贴边隐藏'}<kbd>F4</kbd></button>
      <button className="tool small" onClick={() => setDialog({ kind: 'save-group' })}><BookmarkPlus size={14} />存为参考组</button>
      <button className={`tool small${canvasMode ? ' is-on' : ''}`} onClick={() => setCanvasMode((v) => !v)} title="把 Kinshoko 换成一块空白画布，感受钉图浮在绘画软件上的样子"><Brush size={14} />{canvasMode ? '回到 Kinshoko' : '模拟画布'}</button>
      <button className="tool small" onClick={() => { setPins([]); setEdgeHidden(false); }}><PinOff size={14} />全部关闭</button>
    </div>}

    <div className="fx-layer" ref={fxHost} aria-hidden="true" />
    {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />

    {dialog?.kind === 'save-group' && <SaveGroupDialog pins={pins} captures={captures} libraries={libraries} currentLibrary={library.id}
      resolve={resolvePin} isHidden={isHidden} onClose={() => setDialog(null)}
      onSave={(name, collect) => {
        // Uncollected captures are collected first: groups reference library images only (Q70).
        const converted = new Map<string, { libraryId: string; imageId: string }>();
        for (const [captureId, libraryId] of Object.entries(collect)) {
          const capture = captures.find((c) => c.id === captureId);
          if (capture && libraryId) { const img = collectCapture(capture, libraryId, null); converted.set(captureId, { libraryId, imageId: img.id }); }
        }
        const members = pins.flatMap((p) => {
          const view = p.source.kind === 'view' ? p.source.view
            : converted.get(p.source.captureId) ? { ...converted.get(p.source.captureId)!, crop: null }
              : (() => { const c = captures.find((x) => x.id === (p.source as { captureId: string }).captureId); return c?.collectedAs ? { ...c.collectedAs, crop: null } : null; })();
          return view ? [{ view, x: p.x, y: p.y, scale: p.scale, flipH: p.flipH, flipV: p.flipV, rotate: p.rotate }] : [];
        });
        const group: ReferenceGroup = { id: uid('group'), name, savedAt: Date.now(), members };
        setGroups((g) => [group, ...g]);
        setDialog(null);
        setSection('groups');
        setPane(true);
        log('group-save', { members: members.length, libraries: new Set(members.map((m) => m.view.libraryId)).size });
        toast(`已保存参考组「${name}」：${members.length} 个成员。`);
      }} />}
    {dialog?.kind === 'open-group' && <Dialog title={`打开「${dialog.group.name}」`} onClose={() => setDialog(null)} actions={<>
      <button onClick={() => setDialog(null)}>取消</button>
      <button onClick={() => { openGroup(dialog.group, 'add'); setDialog(null); }}>和当前钉图一起显示</button>
      <button className="primary" onClick={() => { openGroup(dialog.group, 'replace'); setDialog(null); }}>替换当前钉图</button>
    </>}><p>桌面上已有 {pins.length} 张钉图。替换后它们会关闭；没存进参考组的摆放不会保留。</p></Dialog>}
    {dialog?.kind === 'delete-group' && <Dialog title={`删除参考组「${dialog.group.name}」？`} onClose={() => setDialog(null)} actions={<>
      <button onClick={() => setDialog(null)}>取消</button>
      <button className="danger-fill" onClick={() => { setGroups((l) => l.filter((g) => g.id !== dialog.group.id)); setDialog(null); }}>删除参考组</button>
    </>}><p>只删除这个组的成员与布局。资料库里的参考图、标签和其他参考组不受影响。</p></Dialog>}
    {dialog?.kind === 'collect' && <CollectDialog capture={dialog.capture} libraries={libraries} current={library.id} onClose={() => setDialog(null)}
      onCollect={(libId, folderId) => { const img = collectCapture(dialog.capture, libId, folderId); setDialog(null); toast(`已收藏到「${libraries.find((l) => l.id === libId)?.name}」。`, { label: '查看', run: () => { setLibraryId(libId); openImage(img); } }); }} />}
    {dialog?.kind === 'settings' && <SettingsDialog settings={settings} onChange={setSettings} onPreviewDensity={(v) => wall.current?.previewDensity(v)} onClose={() => setDialog(null)} info={seedInfo}
      onExportLog={exportLog} onReset={() => { resetPersistent(); location.reload(); }} onHelp={() => setDialog({ kind: 'help' })} />}
    {dialog?.kind === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
  </div>;
}

function SaveGroupDialog(p: {
  pins: Pin[]; captures: Capture[]; libraries: Library[]; currentLibrary: string;
  resolve: (pin: Pin) => { image?: ReferenceImage; capture?: Capture; missing?: boolean };
  isHidden: (image: ReferenceImage) => boolean;
  onClose: () => void; onSave: (name: string, collect: Record<string, string>) => void;
}) {
  const [name, setName] = useState(`参考组 ${now()}`);
  const pending = p.captures.filter((c) => !c.collectedAs && p.pins.some((pin) => pin.source.kind === 'capture' && pin.source.captureId === c.id));
  const [collect, setCollect] = useState<Record<string, string>>(() => Object.fromEntries(pending.map((c) => [c.id, p.currentLibrary])));
  const kept = p.pins.filter((pin) => pin.source.kind === 'view' || collect[pin.source.captureId]).length;
  return <Dialog title="存为参考组" wide onClose={p.onClose} actions={<>
    <button onClick={p.onClose}>取消</button>
    <button className="primary" disabled={!kept} onClick={() => p.onSave(name.trim() || '未命名参考组', collect)}>保存 {kept} 个成员</button>
  </>}>
    <label className="field"><span>名称</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
    <div className="member-strip">
      {p.pins.map((pin) => {
        const src = p.resolve(pin);
        return pin.source.kind === 'view'
          ? <ViewThumb key={pin.id} image={src.image} crop={pin.source.view.crop} box={64} veiled={src.image ? p.isHidden(src.image) : false} />
          : <span key={pin.id} className="vthumb capture"><img src={src.capture?.url} alt="" style={{ maxWidth: 64, maxHeight: 64 }} /></span>;
      })}
    </div>
    <p className="muted small">保存每个成员的局部、位置、大小、翻转与旋转；透明度和锁定属于桌面状态，不随组保存。组只保存引用，不复制原图。</p>
    {pending.length > 0 && <div className="pending">
      <h3>{pending.length} 张截图还没有收藏</h3>
      <p className="muted small">参考组只引用资料库中的参考图。选择收藏到哪个资料库；选“不收藏”的截图不进组，仍留在桌面上。</p>
      {pending.map((c) => <div key={c.id} className="pending-row">
        <span className="cap-thumb"><img src={c.url} alt="" /></span>
        <span className="grow">{c.label}<br /><span className="muted small tabular">{c.w} × {c.h}</span></span>
        <select value={collect[c.id] ?? ''} onChange={(e) => setCollect((x) => ({ ...x, [c.id]: e.target.value }))} aria-label="收藏到">
          {p.libraries.map((l) => <option key={l.id} value={l.id}>收藏到 {l.name}</option>)}
          <option value="">不收藏，不进组</option>
        </select>
      </div>)}
    </div>}
  </Dialog>;
}

function CollectDialog(p: { capture: Capture; libraries: Library[]; current: string; onClose: () => void; onCollect: (libraryId: string, folderId: string | null) => void }) {
  const [lib, setLib] = useState(p.current);
  const [folder, setFolder] = useState('');
  const library = p.libraries.find((l) => l.id === lib)!;
  return <Dialog title="收藏截图" onClose={p.onClose} actions={<>
    <button onClick={p.onClose}>取消</button>
    <button className="primary" onClick={() => p.onCollect(lib, folder || null)}>收藏</button>
  </>}>
    <div className="collect-preview"><img src={p.capture.url} alt="" /></div>
    <label className="field"><span>资料库</span><select value={lib} onChange={(e) => { setLib(e.target.value); setFolder(''); }}>{p.libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <label className="field"><span>文件夹</span><select value={folder} onChange={(e) => setFolder(e.target.value)}>
      <option value="">不放进文件夹</option>{library.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
    <p className="muted small">收藏后它成为这个资料库的参考图；正式版随后自动打标与分级。</p>
  </Dialog>;
}

