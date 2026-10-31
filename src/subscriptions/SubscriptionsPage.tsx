import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Clock, Info, LoaderCircle, LogOut, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Rss, TriangleAlert, User } from "lucide-react";
import type { ReceivedImage } from "../bindings/ReceivedImage";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText, thumbnailUrl } from "../ipc";
import { subscriptionCheckNow, subscriptionMarkSeen, subscriptionRecent, subscriptions as listSubscriptions } from "../ipc/subscriptions";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { WinCtrls } from "../ui/WinCtrls";
import { accountActions } from "./accountActions";
import { checkedText, checkView, failureText, retryText } from "./checkStatus";
import { FirstRunDialog, firstRunSeen, markFirstRunSeen } from "./FirstRunDialog";
import { hiddenWhenSafe, KINDS, kindOf, type KindMount } from "./kinds";
import { UnofficialMark } from "./UnofficialMark";

/** 图片墙的缩略图档位（`thumbnailTier` 的一档），五列左右时够清楚。 */
const TILE_PX = 384;

/** 每分钟走一下，让“几分钟前查过”跟着变。 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * 订阅名单与最近收进来的图，跟着订阅状态推送重读。订阅页开着时把新图标为已看（入口与托盘清零），
 * 这次打开期间收到的仍排在“新收到”里，离开订阅页才归入“之前”。
 */
function useSubscriptionData(status: SubscriptionStatus, onError: (e: unknown) => void) {
  const [list, setList] = useState<Subscription[] | null>(null);
  const [recent, setRecent] = useState<ReceivedImage[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const signedIn = status.login.state !== "loggedOut";
  const errors = useRef(onError);
  errors.current = onError;
  useEffect(() => {
    if (!signedIn) { setList([]); setRecent([]); return; }
    let alive = true;
    listSubscriptions().then((next) => alive && setList(next), (e) => { if (alive) { setList([]); errors.current(e); } });
    subscriptionRecent().then((next) => {
      if (!alive) return;
      setRecent(next);
      const arrived = next.filter((image) => image.new);
      if (arrived.length === 0) return;
      setFresh((seen) => new Set([...seen, ...arrived.map(imageKey)]));
      void subscriptionMarkSeen().catch(() => {});
    }, (e) => { if (alive) errors.current(e); });
    return () => { alive = false; };
  }, [status, signedIn]);
  return { list, recent, fresh };
}

const imageKey = (image: ReceivedImage) => `${image.libraryId}/${image.imageId}`;

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
  kinds?: KindMount[];
}) {
  const { t } = useTranslation("subscriptions");
  const { t: tw } = useTranslation("workspace");
  const toast = useToast();
  const report = (message: string) => { if (toast) toast.error(message); };
  const onError = (e: unknown) => report(errorText(e));
  const now = useNow();
  const { list, recent, fresh } = useSubscriptionData(status, onError);
  const [selected, setSelected] = useState<string | null>(null);
  const [failedTiles, setFailedTiles] = useState<ReadonlySet<string>>(new Set());
  // 缩略图读不出来可能只是暂时的（例如安全模式下被分级挡住）：换了安全模式或重读后再试。
  useEffect(() => { setFailedTiles(new Set()); }, [safe, recent]);
  const login = status.login;
  const account = login.state === "loggedOut" ? null : login.account;
  const signingIn = status.signingIn && login.state !== "loggedIn";
  const actions = accountActions(report, onStatus);

  const [firstRun, setFirstRun] = useState(() => login.state === "loggedOut" && !status.signingIn && !firstRunSeen());
  const closeFirstRun = () => { markFirstRunSeen(); setFirstRun(false); };

  const visible = useMemo(() => (list ?? []).filter((s) => !safe || !hiddenWhenSafe(s, kinds)), [list, safe, kinds]);
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);
  useEffect(() => { if (selected !== null && !visibleIds.has(selected)) setSelected(null); }, [selected, visibleIds]);
  const images = recent.filter((image) => (!safe || !image.explicit) && visibleIds.has(image.subscriptionId) && !failedTiles.has(imageKey(image)));
  const shown = selected === null ? images : images.filter((image) => image.subscriptionId === selected);
  const freshImages = shown.filter((image) => fresh.has(imageKey(image)));
  const earlier = shown.filter((image) => !fresh.has(imageKey(image)));
  const freshBySubscription = useMemo(() => {
    const counts = new Map<string, number>();
    for (const image of images) if (fresh.has(imageKey(image))) counts.set(image.subscriptionId, (counts.get(image.subscriptionId) ?? 0) + 1);
    return counts;
  }, [images, fresh]);

  const hasList = account !== null && visible.length > 0;
  const check = checkView(status, visible, now);
  const checkNow = () => { subscriptionCheckNow().catch((e) => report(t("check.failed", { error: errorText(e) }))); };

  const addMenu = (trigger: ReactElement) => <Menu.Root modal={false}>
    <Menu.Trigger render={trigger} />
    <MenuPopup label={t("add")} width={200}>
      {kinds.map((k) => <MenuItem key={k.kind} icon={k.icon(16)} disabled={!k.add} onClick={k.add}>{t(`addMenu.${k.kind}`)}</MenuItem>)}
    </MenuPopup>
  </Menu.Root>;

  return <>
    <aside className="sidebar-slot pane subs-pane" data-collapsed={!paneOpen} aria-label={t("title")} aria-hidden={!paneOpen} inert={!paneOpen}>
      <header className="pane-head" data-tauri-drag-region>
        <div className="subs-pane-title">
          <h1 className="pane-title">{t("title")}</h1>
          <UnofficialMark />
        </div>
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
                return <button key={s.id} type="button" className={`subs-row is-item${selected === s.id ? " is-on" : ""}`}
                  aria-current={selected === s.id ? "true" : undefined} title={s.lastError ? failureText(s.lastError) : undefined}
                  onClick={() => setSelected(selected === s.id ? null : s.id)}>
                  <span className="subs-row-name">{s.name}</span>
                  {s.lastError && <TriangleAlert className="subs-row-warn" size={14} strokeWidth={2} role="img" aria-label={t("lastFailed")} />}
                  {count > 0 && <span className="subs-row-fresh tabular">{count}</span>}
                </button>;
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
        {hasList && <h1 className="subs-title">{t("recent.title")}<span className="subs-title-count tabular">{t("recent.count", { count: shown.length })}</span></h1>}
        <span className="k-grow" />
        {check.kind === "idle" && <>
          <span className="subs-check">{checkedText(check.lastCheckedAt, now)}</span>
          <button type="button" className="k-icon-btn" aria-label={t("check.now")} title={t("check.now")} onClick={checkNow}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </>}
        {check.kind === "checking" && <span className="subs-check" role="status"><LoaderCircle className="subs-spin is-accent" size={14} aria-hidden="true" />{t("check.checking")}</span>}
        {check.kind === "backoff" && <span className="subs-check" role="status" title={t("check.retryTip")}><Clock size={14} strokeWidth={1.75} aria-hidden="true" />{retryText(check.until)}</span>}
        <WinCtrls />
      </header>
      {login.state === "expired" && <div className="subs-banner" role="status">
        <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
        <span className="subs-banner-text" title={t("expired.tip")}>{t("expired.banner")}</span>
        <button type="button" className="k-btn is-primary" onClick={actions.signIn}><span className="k-label">{t("account.signInAgain")}</span></button>
      </div>}
      {hasList ? <div className="subs-wall">
        {shown.length === 0 && <p className="subs-none">{t("recent.none")}</p>}
        {freshImages.length > 0 && <section aria-label={t("recent.fresh")}>
          <h2 className="subs-section">{t("recent.fresh")}<span className="subs-section-count tabular">{freshImages.length}</span></h2>
          <Tiles images={freshImages} label={t("recent.open")} onOpen={onOpenImage} onFail={(key) => setFailedTiles((s) => new Set([...s, key]))} />
        </section>}
        {earlier.length > 0 && <section aria-label={t("recent.earlier")}>
          <h2 className="subs-section is-quiet">{t("recent.earlier")}</h2>
          <Tiles images={earlier} label={t("recent.open")} onOpen={onOpenImage} onFail={(key) => setFailedTiles((s) => new Set([...s, key]))} />
        </section>}
      </div> : list !== null && <div className="subs-empty">
        <span className="subs-empty-icon" aria-hidden="true">{signingIn ? <LoaderCircle className="subs-spin is-accent" size={24} /> : <Rss size={24} strokeWidth={1.75} />}</span>
        {signingIn ? <>
          <h1 className="subs-empty-title">{t("empty.waitingTitle")}</h1>
          <p className="subs-empty-hint">{t("empty.waitingHint")}</p>
          <div className="subs-empty-actions">
            <button type="button" className="k-btn is-quiet" onClick={actions.cancel}><span className="k-label">{t("empty.cancel")}</span></button>
            <button type="button" className="k-btn" onClick={actions.signIn}><span className="k-label">{t("empty.backToWindow")}</span></button>
          </div>
        </> : account ? <>
          <h1 className="subs-empty-title">{t("empty.noSubsTitle")}</h1>
          <p className="subs-empty-hint">{t("empty.noSubsHint")}</p>
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
    <FirstRunDialog open={firstRun} signedIn={account !== null} onClose={closeFirstRun}
      onSignIn={() => { closeFirstRun(); actions.signIn(); }} />
  </>;
}

function Tiles({ images, label, onOpen, onFail }: {
  images: ReceivedImage[]; label: string; onOpen: (libraryId: string, imageId: string) => void; onFail: (key: string) => void;
}) {
  return <ul className="subs-tiles">
    {images.map((image) => <li key={imageKey(image)}>
      <button type="button" className="subs-tile" aria-label={label} title={label} onClick={() => onOpen(image.libraryId, image.imageId)}>
        <img src={thumbnailUrl(`${image.libraryId}/${image.imageId}/${TILE_PX}`)} alt="" decoding="async" draggable={false}
          onError={() => onFail(imageKey(image))} />
      </button>
    </li>)}
  </ul>;
}
