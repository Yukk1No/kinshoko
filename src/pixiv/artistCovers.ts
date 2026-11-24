import { useEffect, useRef, useState } from "react";
import { pixivImageSrc, subscriptionBrowse } from "../ipc/pixivBrowse";

/** 一张卡片最多几张缩略图。 */
export const COVERS = 4;
/** 同时最多读几位画师：画师页一屏几十张卡片，别一下子把请求全发出去。 */
const AT_ONCE = 2;

const cache = new Map<string, Promise<string[]>>();
let running = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(run: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await run();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * 一位画师在 pixiv 上最新几个插画的缩略图地址（卡片上还没收过图时用）。读过的记住，这次打开应用不再读；读不了时为空，
 * 下次再试。安全模式下不含成人作品。
 */
export function remoteCovers(userId: string, safe: boolean): Promise<string[]> {
  const key = `${userId}:${safe}`;
  let found = cache.get(key);
  if (!found) {
    found = inTurn(() => subscriptionBrowse({ kind: "artist", userId, manga: false })).then((page) =>
      page.works
        .filter((w) => !(safe && w.explicit))
        .map((w) => pixivImageSrc(w.pages[0]?.preview ?? ""))
        .filter((src): src is string => !!src)
        .slice(0, COVERS),
    );
    found.catch(() => cache.delete(key));
    cache.set(key, found);
  }
  return found;
}

/**
 * 卡片滚进来时才去读 pixiv 上的缩略图（`wanted` 为假时不读，例如本机已经收过这位画师的图）。返回挂到卡片上的
 * ref 和读到的地址。
 */
export function useRemoteCovers(userId: string, safe: boolean, wanted: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  const key = `${userId}:${safe}`;
  // 读到的地址记着是按哪位画师、哪种安全模式读的：换了就立刻不显示，不等新的读回来（安全模式打开时不能留着成人作品）。
  const [found, setFound] = useState<{ key: string; covers: string[] } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!wanted || !element || typeof IntersectionObserver === "undefined") return;
    let alive = true;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      remoteCovers(userId, safe).then(
        (covers) => alive && setFound({ key: `${userId}:${safe}`, covers }),
        () => {},
      );
    });
    seen.observe(element);
    return () => {
      alive = false;
      seen.disconnect();
    };
  }, [userId, safe, wanted]);
  return { ref, covers: wanted && found?.key === key ? found.covers : [] };
}
