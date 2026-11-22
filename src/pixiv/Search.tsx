import { Search as SearchIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { PixivArtist } from "../bindings/PixivArtist";
import { subscriptionSearchArtists } from "../ipc/pixivBrowse";
import { isComposingKey } from "../ui/composing";
import { Segmented } from "../ui/Segmented";
import { TARGET } from "../wall/wallShared";
import { FollowButton } from "./PixivWall";
import { PixivStatus } from "./Status";
import { useFeedbackContext } from "./useFeedback";

export type SearchKind = "works" | "artists";

/** 离底还剩多少像素时读下一页画师。 */
const NEAR_END = 600;

/**
 * 标题行左端的搜索（#461）：收着时是一个图标，点它或按 Ctrl+F、`/` 向右展开成输入框。按回车交给 `onSubmit`；
 * Esc、× 或框空着点到别处时收回（`onClose`）。`filtering` 时是“画师”页的原地筛选：没有“作品｜画师”切换。
 */
export function SearchBox({
  open,
  text,
  kind,
  filtering,
  onOpen,
  onText,
  onKind,
  onSubmit,
  onClose,
}: {
  open: boolean;
  text: string;
  kind: SearchKind;
  filtering: boolean;
  onOpen: () => void;
  onText: (text: string) => void;
  onKind: (kind: SearchKind) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Ctrl+F 或 `/` 打开；正在别的输入框里打字时 `/` 不算。
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      const ctrlF = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
      if (!ctrlF && !slash) return;
      e.preventDefault();
      openRef.current();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open)
    return (
      <button
        type="button"
        className="k-icon-btn"
        aria-label={t("browse.search")}
        title={t("browse.search")}
        onClick={onOpen}
      >
        <SearchIcon aria-hidden />
      </button>
    );
  return (
    <div
      ref={box}
      className="pw-search"
      role="search"
      onBlur={(e) => {
        // 框空着又点到别处时收回。
        if (!text.trim() && !box.current?.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <SearchIcon aria-hidden className="pw-search-icon" />
      <input
        ref={input}
        className="k-input"
        type="search"
        aria-label={t("browse.search")}
        placeholder={t(
          filtering ? "browse.filterArtists" : kind === "artists" ? "browse.searchArtists" : "browse.searchWorks",
        )}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          // 输入法选字时的回车、Esc 是给输入法的。
          if (isComposingKey(e)) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && !filtering && text.trim()) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {!filtering && (
        <Segmented<SearchKind>
          label={t("browse.searchKind")}
          value={kind}
          onChange={onKind}
          options={[
            { value: "works", label: t("browse.searchKindWorks") },
            { value: "artists", label: t("browse.searchKindArtists") },
          ]}
        />
      )}
      <button type="button" className="k-icon-btn is-sm" aria-label={t("browse.closeSearch")} onClick={onClose}>
        <X aria-hidden />
      </button>
    </div>
  );
}

/** 按名字找到的画师（pixiv 的画师搜索），往下滚读下一页。点一位看作品。 */
export function ArtistResults({ word, onArtist }: { word: string; onArtist: (artist: Artist) => void }) {
  const { t } = useTranslation("subscriptions");
  const feedback = useFeedbackContext();
  const [artists, setArtists] = useState<PixivArtist[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const generation = useRef(0);

  const load = useCallback(
    (cursor: string | null) => {
      const gen = generation.current;
      setLoading(true);
      setFailed(null);
      subscriptionSearchArtists(word, cursor).then(
        (page) => {
          if (gen !== generation.current) return;
          setArtists((list) => {
            const seen = new Set(list.map((a) => a.userId));
            return [...list, ...page.artists.filter((a) => !seen.has(a.userId))];
          });
          setNext(page.next);
          setDone(page.next === null);
          setLoading(false);
        },
        (error: unknown) => {
          if (gen !== generation.current) return;
          setFailed(error);
          setLoading(false);
        },
      );
    },
    [word],
  );

  useEffect(() => {
    generation.current += 1;
    setArtists([]);
    setNext(null);
    setDone(false);
    load(null);
  }, [load]);

  // 一页放不满（窗口大、格子多）时滚不动，滚动就不会要下一页：读完一页后看一眼，还有空就接着读。
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || loading || done || failed || !artists.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) load(next);
  }, [artists, loading, done, failed, next, load]);

  const learn = feedback?.learn;
  useEffect(() => learn?.(artists.map((a) => [a.userId, a.followed])), [artists, learn]);

  return (
    <div
      ref={scroller}
      className="pw-results"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (!loading && !done && !failed && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) load(next);
      }}
    >
      {artists.length > 0 && (
        <ul
          className="pw-artists"
          aria-label={t("browse.searchKindArtists")}
          style={{ "--pw-column": `${TARGET}px` } as React.CSSProperties}
        >
          {artists.map((a) => {
            const following = feedback?.followed(a.userId) ?? a.followed;
            return (
              <li key={a.userId} className="pw-artist-row">
                <button
                  type="button"
                  className="pw-artist"
                  onClick={() => onArtist({ userId: a.userId, name: a.name })}
                >
                  <span className="pw-artist-name">{a.name}</span>
                  <span className="k-description">{t("browse.artistId", { id: a.userId })}</span>
                </button>
                {feedback && (
                  <FollowButton
                    followed={following}
                    busy={feedback.followPending(a.userId)}
                    onToggle={() => void feedback.setFollow({ userId: a.userId, name: a.name }, !following)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <PixivStatus
        loading={loading}
        failed={failed || null}
        retry={() => load(next)}
        empty={done && !artists.length ? t("browse.empty") : null}
      />
    </div>
  );
}
