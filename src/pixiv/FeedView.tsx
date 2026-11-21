import { useMemo } from "react";
import type { Artist } from "../bindings/Artist";
import type { Feed } from "../bindings/Feed";
import type { WallSection } from "./PixivWall";
import { usePixivFeed } from "./usePixivFeed";
import { WallView } from "./WallView";

/** 一条作品流占满一面墙：榜单、我的收藏、一位画师的作品。往下滚时读下一页。 */
export function FeedView({ feed, safe, onArtist }: { feed: Feed; safe: boolean; onArtist?: (artist: Artist) => void }) {
  const state = usePixivFeed(feed);
  const sections = useMemo<WallSection[]>(() => [{ key: feed.kind, works: state.works }], [feed.kind, state.works]);
  const empty = state.done && !state.loading && !state.error && !state.works.length;
  return (
    <WallView
      sections={sections}
      safe={safe}
      status={{ loading: state.loading, failed: state.error, retry: state.retry, empty }}
      onNearEnd={state.more}
      onArtist={onArtist}
    />
  );
}
