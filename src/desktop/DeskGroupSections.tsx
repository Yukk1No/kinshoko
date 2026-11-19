import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { MemberStatus } from "../bindings/MemberStatus";
import { captureUrl, thumbnailUrl } from "../ipc";

/** 与 tokens.css 的 `--t-slow` 相同：指示块滑动的时长，滑动中尺寸变了照样滑过去。 */
const SLIDE_MS = 260;

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <>
      <h3 className="desk-groups-heading" id={id}>
        {title}
      </h3>
      <ul className="desk-groups-list" aria-labelledby={id}>
        {children}
      </ul>
    </>
  );
}

/** 常用与最近的卡片上的前几张缩略图；安全模式下被遮蔽的不显示图。 */
export function Thumbs({ groupId, members }: { groupId: string; members: MemberStatus[] }) {
  return (
    <span className="desk-group-thumbs" aria-hidden="true">
      {members.slice(0, 5).map((m) => (
        <span
          key={m.memberId}
          className={`desk-group-thumb${m.state.kind === "available" ? (m.state.sealed ? " is-sealed" : "") : " is-missing"}`}
        >
          {m.state.kind === "available" && !m.state.sealed && (
            <img
              src={
                "libraryId" in m
                  ? thumbnailUrl(`${m.libraryId}/${m.imageId}/128`)
                  : captureUrl(`group/${groupId}/${m.memberId}`)
              }
              alt=""
              draggable={false}
            />
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * 三段与指示块：指示块按桌面上那一项的位置和高度摆，换一项时用 `--t-slow` 加弹簧滑过去
 * （design/ui-system/visual-and-motion.md），跨段也一样。第一次出现、尺寸变化直接到位；桌面空着时不出现。
 */
export function Sections({
  onDesk,
  reduced,
  children,
}: {
  onDesk: string | null;
  reduced: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const placed = useRef<string | null>(null);
  const slidingUntil = useRef(0);
  const place = useCallback(
    (slide: boolean) => {
      const thumb = mark.current;
      const box = root.current;
      const on = onDesk
        ? [...(box?.querySelectorAll<HTMLElement>(".desk-group") ?? [])].find((el) => el.dataset.id === onDesk)
        : undefined;
      if (!thumb || !box) return;
      if (!on) {
        thumb.hidden = true;
        return;
      }
      thumb.style.transition = slide && !reduced ? "" : "none";
      thumb.style.height = `${on.offsetHeight}px`;
      // 按排版位置算，不用 getBoundingClientRect：换段的卡片这时还带着 layout 动画的反向位移。
      let top = 0;
      for (let el: HTMLElement | null = on; el && el !== box; el = el.offsetParent as HTMLElement | null)
        top += el.offsetTop;
      thumb.style.transform = `translateY(${top}px)`;
      thumb.hidden = false;
    },
    [onDesk, reduced],
  );

  useLayoutEffect(() => {
    const slide = placed.current !== null && onDesk !== null && placed.current !== onDesk;
    if (slide) slidingUntil.current = performance.now() + SLIDE_MS;
    // 滑动中又重排（例如成员读回来了）：照样朝新位置滑。
    place(slide || performance.now() < slidingUntil.current);
    if (onDesk !== null) placed.current = onDesk;
  });

  // 卡片随面板宽度、改名、展开成员变高：跟着到位，正在滑时朝新位置滑。
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const observer = new ResizeObserver(() => place(performance.now() < slidingUntil.current));
    observer.observe(box);
    return () => observer.disconnect();
  }, [place]);

  return (
    <div ref={root} className="desk-groups-switch">
      <span ref={mark} className="desk-groups-mark" aria-hidden="true" hidden />
      {children}
    </div>
  );
}
