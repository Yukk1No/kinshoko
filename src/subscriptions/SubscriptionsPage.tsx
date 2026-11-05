import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Clock, Info, LoaderCircle, LogOut, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Rss, TriangleAlert, User } from "lucide-react";
import type { ReceivedImage } from "../bindings/ReceivedImage";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { captureImage, useCaptureSources } from "../desktop/captureSources";
import { errorText, thumbnailUrl } from "../ipc";
import { subscriptionCheckNow } from "../ipc/subscriptions";
import { modalOpen } from "../ui/modal";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { WinCtrls } from "../ui/WinCtrls";
import { accountActions } from "./accountActions";
import { checkedText, checkView, failureText, retryText } from "./checkStatus";
import { FirstRunDialog, firstRunSeen, markFirstRunSeen } from "./FirstRunDialog";
import { hiddenWhenSafe, KINDS, kindOf, type KindMount } from "./kinds";
import { displayName } from "./rankingNames";
import { RemoveDialog } from "./RemoveDialog";
import { imageKey, useNow, useSubscriptionData } from "./useSubscriptionData";

/** 图片墙的缩略图档位（`thumbnailTier` 的一档），五列左右时够清楚。 */
const TILE_PX = 384;

/**
 * 订阅页（#368，原型第 1–12 号画板）：左侧订阅名单与账号，右侧最近收进来的图。
 * 安全模式开着时不显示成人作品与 `hiddenWhenSafe` 的订阅，也不出现 R-18 字样；切换当即生效，
 * 不等后端重读。画师、榜单、收藏夹的添加流程由 #369–#371 挂在 `kinds` 上。
 */
export function SubscriptionsPage({ status, onStatus, safe, paneOpen, onPaneToggle, onOpenImage, kinds = KINDS }: {
  status: SubscriptionStatus;
  onStatus: (status: SubscriptionStatus) => void;
  safe: boolean;
  paneOpen: boolean;
  onPaneToggle: () => void;
  /** “在图库中打开”：回到图片与文件夹，在查看器里打开这张图。 */
  onOpenImage: (libraryId: string, imageId: string) => void;
  /** 当前打开的资料库：新订阅默认收进这里。 */
  kinds?: KindMount[];
}) {
  const { t } = useTranslation("subscriptions");
  const { t: tw } = useTranslation("workspace");
  const toast = useToast();
  const report = (message: string) => { if (toast) toast.error(message); };
  const onError = (e: unknown) => report(errorText(e));
  const now = useNow();
  /** 添加、改设置或退订后加一，重读名单。 */
  const [reload, setReload] = useState(0);
  const { list, recent, fresh, stale } = useSubscriptionData(status, safe, reload, onError);
  const [adding, setAdding] = useState<KindMount | null>(null);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [removing, setRemoving] = useState<Subscription | null>(null);
  /** 名单上哪一行的“更多”菜单开着（右键也打开它）。 */
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const changed = () => setReload((n) => n + 1);
  // 安全模式刚打开或范围刚收紧、还没按新视角重读：先一张都不显示，免得画师在图库里改成成人的图
  // 在这期间露出来；重读失败也一直不显示。
  const veiled = stale;
  const [selected, setSelected] = useState<string | null>(null);
  // 缩略图读不出来可能只是暂时的（例如安全模式下被分级挡住）：记下时连同这次读到的结果与安全模式，
  // 换了安全模式或重读后就不算了，再试一次。
  const [failures, setFailures] = useState<{ recent: ReceivedImage[]; safe: boolean; keys: ReadonlySet<string> } | null>(null);
  const current = (f: typeof failures): ReadonlySet<string> => (f?.recent === recent && f.safe === safe ? f.keys : new Set());
  const failedTiles = current(failures);
  const onFail = (key: string) => setFailures((f) => ({ recent, safe, keys: new Set([...current(f), key]) }));
  const login = status.login;
  const account = login.state === "loggedOut" ? null : login.account;
  const signingIn = status.signingIn && login.state !== "loggedIn";
  const actions = accountActions(report, onStatus);

  const [firstRun, setFirstRun] = useState(() => login.state === "loggedOut" && !status.signingIn && !firstRunSeen());
  const closeFirstRun = () => { markFirstRunSeen(); setFirstRun(false); };

  const visible = useMemo(() => (list ?? []).filter((s) => !safe || !hiddenWhenSafe(s, kinds)), [list, safe, kinds]);
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);
  useEffect(() => { if (selected !== null && !visibleIds.has(selected)) setSelected(null); }, [selected, visibleIds]);
  const images = veiled ? [] : recent.filter((image) => (!safe || !image.explicit) && visibleIds.has(image.subscriptionId) && !failedTiles.has(imageKey(image)));
  const shown = selected === null ? images : images.filter((image) => image.subscriptionId === selected);
  const freshImages = shown.filter((image) => fresh.has(imageKey(image)));
  const earlier = shown.filter((image) => !fresh.has(imageKey(image)));
  const freshBySubscription = useMemo(() => {
    const counts = new Map<string, number>();
    for (const image of images) if (fresh.has(imageKey(image))) counts.set(image.subscriptionId, (counts.get(image.subscriptionId) ?? 0) + 1);
    return counts;
  }, [images, fresh]);

  const wall = useRef<HTMLDivElement | null>(null);
  // 截图时登记看得见的缩略图，钉出来的是图库原图的裁切（与图片墙同一条路）。图库藏在后面时图片墙与
  // 没关的查看器仍登记着、只答空，所以订阅页（只在显示时挂着）的优先级要高过它们。
  useCaptureSources(() => {
    if (!wall.current || modalOpen()) return null;
    return [...wall.current.querySelectorAll<HTMLImageElement>(".subs-tile img")].flatMap((image) => {
      const tile = image.closest<HTMLElement>(".subs-tile")!;
      const { libraryId, imageId } = tile.dataset;
      if (!libraryId || !imageId) return [];
      const reference = captureImage(image, wall.current!, libraryId, imageId, image.naturalWidth, image.naturalHeight);
      return reference ? [reference] : [];
    });
  }, 200);

  const hasList = account !== null && visible.length > 0;
  /** 选中的订阅跳过了几个动图（#366：订阅记录里标明“已跳过”）。 */
  const skipped = visible.find((s) => s.id === selected)?.skipped ?? 0;
  const mountOf = (s: Subscription) => kinds.find((k) => k.kind === kindOf(s.target));
  const flow = { status, safe, list: list ?? [] };
  const check = checkView(status, visible, now);
  const checkNow = () => { subscriptionCheckNow().catch((e) => report(t("check.failed", { error: errorText(e) }))); };

  const addMenu = (trigger: ReactElement) => <Menu.Root modal={false}>
    <Menu.Trigger render={trigger} />
    <MenuPopup label={t("add")} width={200}>
      {kinds.map((k) => <MenuItem key={k.kind} icon={k.icon(16)} disabled={!k.add || (k.full?.(list ?? []) ?? false)} onClick={() => setAdding(k)}>{t(`addMenu.${k.kind}`)}</MenuItem>)}
    </MenuPopup>
  </Menu.Root>;

  return <>
    <aside className="sidebar-slot pane subs-pane" data-collapsed={!paneOpen} aria-label={t("title")} aria-hidden={!paneOpen} inert={!paneOpen}>
      <header className="pane-head" data-tauri-drag-region>
        <h1 className="pane-title subs-pane-title">{t("title")}</h1>
        {account && addMenu(<button type="button" className="k-icon-btn" aria-label={t("add")} title={t("add")}><Plus size={18} strokeWidth={1.75} aria-hidden="true" /></button>)}
        <button type="button" className="k-icon-btn subs-collapse" aria-label={tw("collapsePane")} title={tw("collapsePaneTitle")} onClick={onPaneToggle}><PanelLeftClose size={16} aria-hidden="true" /></button>
      </header>
      <div className="subs-list">
        {hasList && <>
          <button type="button" className={`subs-row is-all${selected === null ? " is-on" : ""}`} aria-current={selected === null ? "true" : undefined} onClick={() => setSelected(null)}>
            <Rss size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="subs-row-name">{t("all")}</span>
            <span className="subs-row-count tabular">{images.length}</span>
          </button>
          <div className="subs-sep" />
          {kinds.map((k) => {
            const rows = visible.filter((s) => kindOf(s.target) === k.kind);
            if (rows.length === 0) return null;
            return <section key={k.kind} className="subs-group" aria-label={t(`groups.${k.kind}`)}>
              <h2 className="subs-group-head"><span className="subs-group-icon">{k.icon(14)}</span>{t(`groups.${k.kind}`)}</h2>
              {rows.map((s) => {
                const count = freshBySubscription.get(s.id) ?? 0;
                return <div key={s.id} className={`subs-row-wrap${rowMenu === s.id ? " is-menu" : ""}`}>
                  <button type="button" className={`subs-row is-item${selected === s.id ? " is-on" : ""}`}
                    aria-current={selected === s.id ? "true" : undefined} title={s.lastError ? failureText(s.lastError) : undefined}
                    onClick={() => setSelected(selected === s.id ? null : s.id)}
                    onContextMenu={(e) => { e.preventDefault(); setRowMenu(s.id); }}>
                    <span className="subs-row-name">{displayName(t, s)}</span>
                    {s.lastError && <TriangleAlert className="subs-row-warn" size={14} strokeWidth={2} role="img" aria-label={t("lastFailed")} />}
                    {count > 0 && <span className="subs-row-fresh tabular">{count}</span>}
                  </button>
                  <Menu.Root modal={false} open={rowMenu === s.id} onOpenChange={(open) => setRowMenu(open ? s.id : null)}>
                    <Menu.Trigger className="k-icon-btn subs-row-more" aria-label={t("row.more")} title={t("row.more")}><MoreHorizontal size={16} aria-hidden="true" /></Menu.Trigger>
                    <MenuPopup label={t("row.more")} width={180}>
                      {k.settings && <MenuItem onClick={() => setEditing(s)}>{t("row.settings")}</MenuItem>}
                      {k.settings && <MenuSeparator />}
                      <MenuItem danger onClick={() => setRemoving(s)}>{t("row.remove")}</MenuItem>
                    </MenuPopup>
                  </Menu.Root>
                </div>;
              })}
            </section>;
          })}
        </>}
      </div>
      <div className="subs-account">
        {signingIn ? <>
          <span className="subs-avatar is-empty" aria-hidden="true"><LoaderCircle className="subs-spin" size={16} /></span>
          <span className="subs-account-text is-muted">{t("account.signingIn")}</span>
        </> : account ? <>
          <span className="subs-avatar" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span>
          <span className="subs-account-text">
            <span className="subs-account-name">{account.name}</span>
            {login.state === "expired"
              ? <span className="subs-account-sub is-warn">{t("account.expired")}</span>
              : <span className="subs-account-sub">{t("account.source")}</span>}
          </span>
          {login.state === "expired" && <button type="button" className="k-btn is-primary" onClick={actions.signIn}><span className="k-label">{t("account.signInAgain")}</span></button>}
          <Menu.Root modal={false}>
            <Menu.Trigger className="k-icon-btn" aria-label={t("account.menu")} title={t("account.menu")}><MoreHorizontal size={16} aria-hidden="true" /></Menu.Trigger>
            <MenuPopup label={t("account.menu")} width={200} side="top">
              <MenuItem icon={<Info size={16} strokeWidth={1.75} />} onClick={() => setFirstRun(true)}>{t("account.risks")}</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<LogOut size={16} strokeWidth={1.75} />} onClick={actions.signOut}>{t("account.signOut")}</MenuItem>
            </MenuPopup>
          </Menu.Root>
        </> : <>
          <span className="subs-avatar is-empty" aria-hidden="true"><User size={16} strokeWidth={1.75} /></span>
          <span className="subs-account-text is-muted">{t("account.signedOut")}</span>
          <button type="button" className="k-btn" onClick={actions.signIn}><span className="k-label">{t("account.signIn")}</span></button>
        </>}
      </div>
    </aside>
    <main className="app-main subs-main">
      <header className="topbar subs-topbar" data-tauri-drag-region>
        {!paneOpen && <button type="button" className="k-icon-btn" onClick={onPaneToggle} aria-label={tw("expandPane")} title={tw("expandPaneTitle")}><PanelLeftOpen size={16} aria-hidden="true" /></button>}
        {hasList && <h1 className="subs-title">{t("recent.title")}<span className="subs-title-count tabular">{t("recent.count", { count: shown.length })}</span>
          {skipped > 0 && <span className="subs-title-count">{t("recent.skipped", { count: skipped })}</span>}</h1>}
        <span className="k-grow" />
        {check.kind === "idle" && <>
          <span className="subs-check">{checkedText(check.lastCheckedAt, now)}</span>
          <button type="button" className="k-icon-btn" aria-label={t("check.now")} title={t("check.now")} onClick={checkNow}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </>}
        {check.kind === "checking" && <span className="subs-check" role="status"><LoaderCircle className="subs-spin is-accent" size={14} aria-hidden="true" />{t("check.checking")}</span>}
        {check.kind === "backoff" && <span className="subs-check" role="status"><Clock size={14} strokeWidth={1.75} aria-hidden="true" />{retryText(check.until)}</span>}
        <WinCtrls />
      </header>
      {login.state === "expired" && <div className="subs-banner" role="status">
        <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
        <span className="subs-banner-text">{t("expired.banner")}</span>
        <button type="button" className="k-btn is-primary" onClick={actions.signIn}><span className="k-label">{t("account.signInAgain")}</span></button>
      </div>}
      {hasList ? <div className="subs-wall" ref={wall}>
        {shown.length === 0 && !veiled && <p className="subs-none">{t("recent.none")}</p>}
        {freshImages.length > 0 && <section aria-label={t("recent.fresh")}>
          <h2 className="subs-section">{t("recent.fresh")}<span className="subs-section-count tabular">{freshImages.length}</span></h2>
          <Tiles images={freshImages} label={t("recent.open")} onOpen={onOpenImage} onFail={onFail} />
        </section>}
        {earlier.length > 0 && <section aria-label={t("recent.earlier")}>
          <h2 className="subs-section is-quiet">{t("recent.earlier")}</h2>
          <Tiles images={earlier} label={t("recent.open")} onOpen={onOpenImage} onFail={onFail} />
        </section>}
      </div> : list !== null && <div className="subs-empty">
        <span className="subs-empty-icon" aria-hidden="true">{signingIn ? <LoaderCircle className="subs-spin is-accent" size={24} /> : <Rss size={24} strokeWidth={1.75} />}</span>
        {signingIn ? <>
          <h1 className="subs-empty-title">{t("empty.waitingTitle")}</h1>
          <div className="subs-empty-actions">
            <button type="button" className="k-btn is-quiet" onClick={actions.cancel}><span className="k-label">{t("empty.cancel")}</span></button>
            <button type="button" className="k-btn" onClick={actions.signIn}><span className="k-label">{t("empty.backToWindow")}</span></button>
          </div>
        </> : account ? <>
          <h1 className="subs-empty-title">{t("empty.noSubsTitle")}</h1>
          <div className="subs-empty-actions">
            {addMenu(<button type="button" className="k-btn is-primary"><span className="k-label">{t("add")}</span><ChevronDown size={14} strokeWidth={2} aria-hidden="true" /></button>)}
          </div>
        </> : <>
          <h1 className="subs-empty-title">{t("empty.signedOutTitle")}</h1>
          <p className="subs-empty-hint">{t("empty.signedOutHint")}</p>
          <div className="subs-empty-actions">
            <button type="button" className="k-btn" onClick={() => setFirstRun(true)}><span className="k-label">{t("account.risks")}</span></button>
            <button type="button" className="k-btn is-primary" onClick={actions.signIn}><span className="k-label">{t("empty.signIn")}</span></button>
          </div>
        </>}
      </div>}
    </main>
    {adding?.add?.({ ...flow, onClose: () => setAdding(null), onAdded: changed })}
    {editing && mountOf(editing)?.settings?.({ ...flow, subscription: editing, onClose: () => setEditing(null), onSaved: changed })}
    {removing && <RemoveDialog subscription={removing} onClose={() => setRemoving(null)}
      onRemoved={() => { if (selected === removing.id) setSelected(null); changed(); }} />}
    <FirstRunDialog open={firstRun} signedIn={account !== null} onClose={closeFirstRun}
      onSignIn={() => { closeFirstRun(); actions.signIn(); }} />
  </>;
}

function Tiles({ images, label, onOpen, onFail }: {
  images: ReceivedImage[]; label: string; onOpen: (libraryId: string, imageId: string) => void; onFail: (key: string) => void;
}) {
  return <ul className="subs-tiles">
    {images.map((image) => <li key={imageKey(image)}>
      <button type="button" className="subs-tile" data-library-id={image.libraryId} data-image-id={image.imageId} aria-label={label} title={label} onClick={() => onOpen(image.libraryId, image.imageId)}>
        <img src={thumbnailUrl(`${image.libraryId}/${image.imageId}/${TILE_PX}`)} alt="" decoding="async" draggable={false}
          onError={() => onFail(imageKey(image))} />
      </button>
    </li>)}
  </ul>;
}

