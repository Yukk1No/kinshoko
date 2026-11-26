import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Heart, User, UserMinus, UserPlus } from "lucide-react";
import type { Artist } from "../bindings/Artist";
import type { PixivWork } from "../bindings/PixivWork";
import { pixivImageSrc } from "../ipc/pixivBrowse";
import { MenuItem, MenuSeparator, PointerMenu } from "../ui/Menu";
import type { PixivLayout } from "./layout";
import { FollowButton } from "./FollowButton";
import type { CollectOptions } from "./useCollect";
import { useFeedbackContext } from "./useFeedback";
import { useSubscriptionsContext } from "./useSubscriptions";

/** 在墙里原地展开的一格：左边大图，右边作品信息。 */
export function Band({
  layout,
  top,
  work,
  collected,
  busy,
  onCollect,
  onArtist,
  onClose,
  onStep,
  onFull,
}: {
  layout: PixivLayout;
  top: number;
  work: PixivWork | undefined;
  collected: ReadonlySet<number> | undefined;
  busy: boolean;
  onCollect?: (work: PixivWork, options?: CollectOptions) => void;
  onArtist?: (artist: Artist) => void;
  onClose: () => void;
  onStep: (delta: number) => void;
  onFull: (work: PixivWork) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const feedback = useFeedbackContext();
  const band = layout.band;
  if (!band || !work) return null;
  const src = pixivImageSrc(work.pages[0]?.large ?? "");
  const all = (collected?.size ?? 0) >= work.pages.length;
  const collectable = !!onCollect && work.kind !== "animation";
  const bookmarked = feedback?.bookmarked(work) ?? work.bookmarked;
  const following = feedback ? (feedback.followed(work.artist.userId) ?? work.followed) : null;
  return (
    <section
      className="pw-band"
      aria-label={t("browse.work", { title: work.title, artist: work.artist.name })}
      style={{ left: band.x, top: top + band.y, width: band.w, height: band.h }}
    >
      <button type="button" className="pw-band-stage" aria-label={t("browse.viewFull")} onClick={() => onFull(work)}>
        {src && <img src={src} alt="" draggable={false} />}
      </button>
      <div className="pw-band-side">
        <h2 className="k-title">{work.title}</h2>
        <p className="pw-band-artist">
          {work.artist.name}
          {feedback && following !== null && (
            <FollowButton
              userId={work.artist.userId}
              followed={following}
              busy={feedback.followPending(work.artist.userId)}
              onToggle={() => void feedback.setFollow(work.artist, !following)}
            />
          )}
          {onArtist && (
            <button type="button" className="k-btn" onClick={() => onArtist(work.artist)}>
              {t("browse.viewArtist")}
            </button>
          )}
        </p>
        {work.pages.length > 1 && <p className="pw-band-meta">{t("browse.pages", { count: work.pages.length })}</p>}
        <ul className="pw-band-tags">
          {work.tags.slice(0, 12).map((tag) => (
            <li key={tag} className="k-token is-24 is-pill is-surface">
              {tag}
            </li>
          ))}
        </ul>
        {collectable && (
          <div className="pw-band-actions">
            {/* “收藏”一次就写 pixiv 收藏并收进资料库（#461）。都做过了才只显示“已收藏”。 */}
            {all && bookmarked ? (
              <span className="pw-band-meta">{t("browse.favorited")}</span>
            ) : (
              <button
                type="button"
                className="k-btn is-primary"
                // pixiv 收藏还在写（例如刚点了取消）时不能点：写完之前的“收藏”会只收图、不写收藏。
                disabled={busy || (feedback?.bookmarkPending(work.id) ?? false)}
                onClick={(e) => onCollect(work, { bookmark: true, from: e.currentTarget.closest(".pw-band") })}
              >
                {busy ? t("browse.collecting") : t("browse.favorite")}
              </button>
            )}
            {/* 资料库里的图被删掉了也能再收（#461）。 */}
            {all && (
              <button
                type="button"
                className="k-btn"
                disabled={busy}
                onClick={(e) => onCollect(work, { again: true, from: e.currentTarget.closest(".pw-band") })}
              >
                {t("browse.collectAgain")}
              </button>
            )}
            <button
              type="button"
              className="k-btn"
              disabled={busy}
              onClick={(e) => onCollect(work, { choose: true, from: e.currentTarget.closest(".pw-band") })}
            >
              {t("browse.collectElsewhere")}
            </button>
            {/* 取消 pixiv 收藏不动资料库里的图。 */}
            {feedback && bookmarked && (
              <button
                type="button"
                className="k-btn"
                disabled={feedback.bookmarkPending(work.id)}
                onClick={() => void feedback.setBookmark(work, false)}
              >
                {t("browse.unbookmark")}
              </button>
            )}
          </div>
        )}
        <div className="pw-band-actions">
          <a className="k-btn" href={work.pageUrl} target="_blank" rel="noreferrer">
            {t("browse.openOnPixiv")}
          </a>
          <button type="button" className="k-btn" onClick={() => onStep(-1)}>
            {t("browse.previous")}
          </button>
          <button type="button" className="k-btn" onClick={() => onStep(1)}>
            {t("browse.next")}
          </button>
          <button type="button" className="k-btn" onClick={onClose}>
            {t("browse.close")}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * 作品卡片的右键菜单（#461“作品卡片”）：收藏（收进图库）、在 pixiv 打开、查看这位画师、关注（同时订阅）。
 * 和展开的一格里的按钮是同一组动作，不用先点开。
 */
export function CardMenu({
  work,
  point,
  collected,
  busy,
  onCollect,
  onArtist,
  onClose,
}: {
  work: PixivWork;
  point: { x: number; y: number };
  collected: ReadonlySet<number> | undefined;
  busy: boolean;
  onCollect?: (work: PixivWork, options?: CollectOptions) => void;
  onArtist?: (artist: Artist) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const feedback = useFeedbackContext();
  const subs = useSubscriptionsContext();
  const collectable = !!onCollect && work.kind !== "animation";
  const all = (collected?.size ?? 0) >= work.pages.length;
  const bookmarked = feedback?.bookmarked(work) ?? work.bookmarked;
  const following = feedback ? (feedback.followed(work.artist.userId) ?? work.followed) : null;
  const userId = work.artist.userId;
  const removing = subs?.artist(userId);
  // 与展开的一格里的“关注”同一套锁：订阅名单没读到、这位画师正在关注或退订时不能点。
  const followLocked =
    !feedback ||
    feedback.followPending(userId) ||
    !!subs?.pending(`artist:${userId}`) ||
    (!!removing && !!subs?.pending(removing.id)) ||
    (!!subs && !subs.ready);
  const card = () => document.querySelector(`.pw-card[data-work="${CSS.escape(work.id)}"]`);
  return (
    <PointerMenu
      point={point}
      label={t("browse.work", { title: work.title, artist: work.artist.name })}
      onClose={onClose}
    >
      {collectable && (
        <MenuItem
          icon={<Heart size={16} strokeWidth={1.75} />}
          disabled={busy || (all && bookmarked) || (feedback?.bookmarkPending(work.id) ?? false)}
          onClick={() => onCollect(work, { bookmark: true, from: card() })}
        >
          {all && bookmarked ? t("browse.favorited") : t("browse.favorite")}
        </MenuItem>
      )}
      <MenuItem
        icon={<ExternalLink size={16} strokeWidth={1.75} />}
        onClick={() => window.open(work.pageUrl, "_blank", "noreferrer")}
      >
        {t("browse.openOnPixiv")}
      </MenuItem>
      {onArtist && (
        <MenuItem icon={<User size={16} strokeWidth={1.75} />} onClick={() => onArtist(work.artist)}>
          {t("browse.viewArtist")}
        </MenuItem>
      )}
      {feedback && following !== null && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={following ? <UserMinus size={16} strokeWidth={1.75} /> : <UserPlus size={16} strokeWidth={1.75} />}
            disabled={followLocked}
            onClick={() => void feedback.setFollow(work.artist, !following)}
          >
            {following ? t("browse.unfollow") : t("browse.follow")}
          </MenuItem>
        </>
      )}
    </PointerMenu>
  );
}

/** 看全图：盖住墙，先在作品内翻页。没收的页读 pixiv 原图，经后端转发。 */
export function FullView({
  work,
  page,
  collected,
  busy,
  onCollect,
  onPage,
  onClose,
}: {
  work: PixivWork;
  page: number;
  collected: boolean;
  busy: boolean;
  onCollect?: (from: Element | null) => void;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const current = work.pages[page];
  const src = pixivImageSrc(current?.original ?? current?.large ?? "");
  const count = work.pages.length;
  return (
    <div
      ref={ref}
      className="pw-full"
      role="group"
      aria-label={t("browse.page", { page: page + 1, count })}
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowRight" && page + 1 < count) onPage(page + 1);
        else if (e.key === "ArrowLeft" && page > 0) onPage(page - 1);
      }}
    >
      {src && <img src={src} alt="" draggable={false} />}
      {onCollect && work.kind !== "animation" && (
        <div className="pw-full-actions">
          {collected ? (
            <span className="pw-collected">{t("browse.collected")}</span>
          ) : (
            <button
              type="button"
              className="k-btn"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onCollect(e.currentTarget.closest(".pw-full"));
              }}
            >
              {busy ? t("browse.collecting") : t(count > 1 ? "browse.collectPage" : "browse.collect")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
