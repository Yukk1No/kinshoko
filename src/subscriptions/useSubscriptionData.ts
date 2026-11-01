import { useEffect, useRef, useState } from "react";
import type { ReceivedImage } from "../bindings/ReceivedImage";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { onSafeModeSetting } from "../ipc";
import { subscriptionMarkSeen, subscriptionRecent, subscriptions as listSubscriptions } from "../ipc/subscriptions";

/** 每分钟走一下，让“同步于几分钟前”跟着变。 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * 订阅名单与最近收进来的图，跟着订阅状态推送与安全模式视角重读。订阅页开着时把新图标为已看（入口与托盘清零），
 * 这次打开期间收到的仍排在“新收到”里，离开订阅页才归入“之前”。
 */
export function useSubscriptionData(status: SubscriptionStatus, safe: boolean, reload: number, onError: (e: unknown) => void) {
  const [list, setList] = useState<Subscription[] | null>(null);
  const [recent, setRecent] = useState<ReceivedImage[]>([]);
  /**
   * 安全模式设置（开关或范围）每变一次加一。范围收紧时 `safe` 不变，已显示的缩略图不会再经后端核对，
   * 所以按这个数判断 `recent` 是不是按现在的视角读的。
   */
  const [lens, setLens] = useState(0);
  useEffect(() => {
    const stop = onSafeModeSetting(() => setLens((n) => n + 1));
    return () => { void stop.then((stop) => stop()); };
  }, []);
  /** 读到 `recent` 时的视角：后端按图库的有效分级去掉了成人作品，前端只知道来源的标记。 */
  const [recentLens, setRecentLens] = useState({ safe, lens });
  const lensRef = useRef({ safe, lens });
  lensRef.current = { safe, lens };
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const signedIn = status.login.state !== "loggedOut";
  const errors = useRef(onError);
  errors.current = onError;
  useEffect(() => {
    if (!signedIn) { setList([]); setRecent([]); return; }
    let alive = true;
    const under = lensRef.current;
    const unseen = status.newCount > 0;
    listSubscriptions().then((next) => alive && setList(next), (e) => { if (alive) { setList([]); errors.current(e); } });
    // 把这次的视角交给后端：后端按它与设置里的安全模式中更严的一个过滤，标成 `under.safe` 不会放宽。
    subscriptionRecent(under.safe).then((next) => {
      if (!alive) return;
      setRecent(next);
      setRecentLens(under);
      const arrived = next.filter((image) => image.new);
      if (arrived.length > 0) setFresh((seen) => new Set([...seen, ...arrived.map(imageKey)]));
      // 入口上的数按来源的标记算，图库里改成成人的图在这里读不到：只看入口上的数，读到的为空也标为已看。
      // 标完后端推送状态，数为零就不再标。
      if (arrived.length > 0 || unseen) void subscriptionMarkSeen().catch(() => {});
    }, (e) => { if (alive) errors.current(e); });
    return () => { alive = false; };
  }, [status, signedIn, safe, lens, reload]);
  /** 安全模式开着，而 `recent` 不是按现在的开关与范围读的。 */
  const stale = safe && (!recentLens.safe || recentLens.lens !== lens);
  return { list, recent, fresh, stale };
}

export const imageKey = (image: ReceivedImage) => `${image.libraryId}/${image.imageId}`;
