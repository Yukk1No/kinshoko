import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, Image, LogOut, RefreshCw, Settings, TriangleAlert } from "lucide-react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc/commandError";
import { pixivImageSrc } from "../ipc/pixivBrowse";
import { subscriptionCheckNow } from "../ipc/subscriptions";
import { DensitySlider } from "../wall/DensitySlider";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { accountActions } from "../subscriptions/accountActions";
import { checkedText, checkView, retryText, useNow } from "../subscriptions/checkStatus";
import { useNewSubscriptionLibrary } from "../subscriptions/SubscriptionSettings";
import { noticeAnchor, rowTopOf } from "../wall/noticeAnchor";
import { NOTICE_VARS } from "../wall/WallFloats";
import type { Subscriptions } from "./useSubscriptions";

/**
 * 订阅页右下角的 pixiv 头像（右下角浮钮的一员，与图片页的打标图标、图片大小同一种外形）：平时是 40 px 的圆钮，
 * 悬停或点一下就在原地往左上长成卡片，圆钮留在卡片右下角。卡片里是检查新作、新订阅收进、图片大小、订阅设置、
 * 退出登录；登录失效时圆钮带警告点，卡片第一行是“重新登录”。
 * 移开指针收回；点过、键盘操作着或下拉列表开着时不收，Esc 或点卡片外面收回。圆钮排在卡片内容前面，
 * 打开后按 Tab 进卡片。
 */
export function AccountFloat({
  status,
  onStatus,
  density,
  onOpenSettings,
  subscriptions,
  leaving = false,
}: {
  status: SubscriptionStatus;
  onStatus: (status: SubscriptionStatus) => void;
  density: { value: number; onCommit: (value: number) => void } | null;
  onOpenSettings: () => void;
  subscriptions: Subscriptions;
  /** 页面正在淡出：通知锚点立刻交还图片页，不等组件卸载。 */
  leaving?: boolean;
}) {
  const { t } = useTranslation("subscriptions");
  const toast = useToast();
  const account = status.login.state === "loggedOut" ? null : status.login.account;
  const expired = status.login.state === "expired";
  const actions = accountActions((message) => toast.error(message), onStatus);
  const [open, setOpen] = useState(false);
  /** 点过圆钮或卡片：移开指针也不收。 */
  const pinned = useRef(false);
  /** 这一下按下之前是否已经点过：再点圆钮是收回。 */
  const pinnedBefore = useRef(false);
  /** 下拉列表开着（列表挂在卡片外面）。 */
  const holding = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 40, height: 40 });
  const now = useNow();
  const library = useNewSubscriptionLibrary();
  const [preview, setPreview] = useState<number | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);

  const close = (focusKnob = false) => {
    pinned.current = false;
    holding.current = false;
    setOpen(false);
    if (focusKnob) knob.current?.focus();
  };

  // 展开时量卡片内容；内容变了（检查状态、名单读到）跟着量。
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) {
      setSize({ width: 40, height: 40 });
      return;
    }
    const measure = () => setSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  useNoticeAboveCorner(root, account !== null && !leaving);

  // 点卡片外面收回；下拉列表开着时那一下是在选列表，不算。
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (holding.current || root.current?.contains(e.target as Node)) return;
      pinned.current = false;
      setOpen(false);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open]);

  if (!account) return null;
  const view = checkView(status, subscriptions.list ?? [], now);
  const checkMeta =
    view.kind === "idle"
      ? checkedText(view.lastCheckedAt, now)
      : view.kind === "checking"
        ? t("check.checking")
        : view.kind === "backoff"
          ? retryText(view.until)
          : null;
  const avatar = pixivImageSrc(account.avatar);
  const showAvatar = avatar && failedAvatar !== avatar;
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <div
      ref={root}
      className="pw-account"
      data-open={open || undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(e) => {
        if (pinned.current || holding.current || e.currentTarget.querySelector(":focus-visible")) return;
        setOpen(false);
      }}
      onPointerDown={() => {
        pinnedBefore.current = pinned.current;
        pinned.current = true;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        if (holding.current || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (e.relatedTarget) close();
      }}
    >
      <div className="pw-account-shape" style={{ width: size.width, height: size.height }}>
        <button
          ref={knob}
          type="button"
          className="pw-account-knob"
          aria-label={t("float.label", { name: account.name })}
          aria-expanded={open}
          onClick={(e) => {
            // 键盘按的没有按下这一步（detail 为 0）：开着就收回。
            if (open && (e.detail === 0 || pinnedBefore.current)) close();
            else {
              pinned.current = true;
              setOpen(true);
            }
          }}
        >
          {showAvatar ? (
            <img src={avatar} alt="" draggable={false} onError={() => setFailedAvatar(avatar)} />
          ) : (
            <span className="pw-account-initial" aria-hidden="true">
              {Array.from(account.name)[0] ?? "p"}
            </span>
          )}
          {expired && <span className="pw-account-dot" aria-hidden="true" />}
        </button>
        <div
          ref={panel}
          className="pw-account-panel"
          role="group"
          aria-label={t("float.label", { name: account.name })}
          inert={!open}
        >
          <div className="pw-account-items">
            {expired && (
              <button type="button" className="pw-account-item is-strong" onClick={run(actions.signIn)}>
                <TriangleAlert size={16} className="is-warn" aria-hidden="true" />
                {t("account.signInAgain")}
              </button>
            )}
            {checkMeta !== null && (
              <button
                type="button"
                className="pw-account-item"
                disabled={view.kind !== "idle"}
                // 卡片不收：这一行就地变成“正在检查”，检查完写新的同步时间。
                onClick={() =>
                  subscriptionCheckNow().catch((e) => toast.error(t("check.failed", { error: errorText(e) })))
                }
              >
                <RefreshCw size={16} aria-hidden="true" />
                {t("settings.check")}
                <span className="k-list-desc pw-account-meta" role="status">
                  {checkMeta}
                </span>
              </button>
            )}
            {library && (
              <div className="pw-account-item is-control">
                <FolderInput size={16} aria-hidden="true" />
                <span>{t("settings.newSubscriptions")}</span>
                <Select
                  label={t("settings.newSubscriptions")}
                  className="is-sm"
                  {...library}
                  onOpenChange={(next) => {
                    holding.current = next;
                  }}
                />
              </div>
            )}
            {density && (
              <div className="pw-account-item is-control">
                <Image size={16} aria-hidden="true" />
                <span>{t("float.density")}</span>
                <DensitySlider
                  value={density.value}
                  preview={preview}
                  onPreview={setPreview}
                  onCommit={(v) => {
                    setPreview(null);
                    density.onCommit(v);
                  }}
                  label={t("float.density")}
                />
              </div>
            )}
            <button type="button" className="pw-account-item" onClick={run(onOpenSettings)}>
              <Settings size={16} aria-hidden="true" />
              {t("browse.subscriptionSettings")}
            </button>
            <div className="pw-account-sep" aria-hidden="true" />
            <button type="button" className="pw-account-item" onClick={run(actions.signOut)}>
              <LogOut size={16} aria-hidden="true" />
              {t("account.signOut")}
            </button>
          </div>
          <div className="pw-account-who">
            <span className="pw-account-name">{account.name}</span>
            <span className={`k-list-desc${expired ? " is-warn" : ""}`}>{expired ? t("float.expired") : "pixiv"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 通知停在头像圆钮上面（与图片页的右下角那一组同一条规则，见 noticeAnchor）。离开订阅页时去掉，通知回到窗口右下角。
 */
function useNoticeAboveCorner(corner: React.RefObject<HTMLDivElement | null>, shown: boolean) {
  useLayoutEffect(() => {
    const own = corner.current;
    const host = own?.parentElement;
    if (!shown || !own || !host) return;
    const root = document.documentElement;
    root.dataset.noticeHost = "subscriptions";
    const measure = () => {
      const box = host.getBoundingClientRect();
      if (box.width === 0) return;
      const anchor = noticeAnchor({
        host: box,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        inset: Number.parseFloat(getComputedStyle(own).right) || 0,
        // 卡片展开时通知让到卡片上面（形状比 40 px 占位高出来的部分）。
        rowTop: rowTopOf(
          own,
          Math.max(0, (own.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0) - own.offsetHeight,
        ),
      });
      root.style.setProperty("--k-notice-right", `${anchor.right}px`);
      root.style.setProperty("--k-notice-bottom", `${anchor.bottom}px`);
      root.style.setProperty("--k-notice-max", `${anchor.maxWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (own.firstElementChild) observer.observe(own.firstElementChild);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      delete root.dataset.noticeHost;
      for (const name of NOTICE_VARS) root.style.removeProperty(name);
    };
  }, [corner, shown]);
}
