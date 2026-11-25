import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import type { BrowserCard } from "./wallShared";
import { useSealRelease } from "./useSealRelease";

function makeCard(id: string, adult: boolean): BrowserCard {
  return {
    id,
    width: 100,
    height: 100,
    adult,
    libraryId: "L1",
    imageId: id,
    sources: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useSealRelease 引用稳定", () => {
  it("关闭安全模式下追加无成人卡的新页时不更换 revealed 引用且不触发额外重渲染", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const revealedHistory: ReadonlySet<string>[] = [];

    function Harness({ cards }: { cards: BrowserCard[] }) {
      const scroller = useRef<HTMLDivElement>(null);
      const shownCards = useRef(cards);
      shownCards.current = cards;
      const live = useRef({ layout: null, ids: cards.map((c) => c.id) });
      const safeReflow = useRef(null);
      const sealDrop = useRef(0);
      const releasePage = useRef(false);
      const { revealed, fxHost } = useSealRelease({
        safeMode: false,
        cards,
        setCards: () => {},
        scroller,
        shownCards,
        live,
        safeReflow,
        sealDrop,
        measureBeforeReflow: () => {},
        viewerOpen: false,
        releasePage,
      });
      revealedHistory.push(revealed);
      return (
        <div ref={scroller}>
          <div ref={fxHost} />
        </div>
      );
    }

    const first = [makeCard("a1", true), makeCard("g1", false)];
    const view = render(<Harness cards={first} />);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    const settledAfterFirst = revealedHistory.at(-1)!;
    expect(settledAfterFirst.has("a1")).toBe(true);
    const rendersBeforeAppend = revealedHistory.length;

    // 追加一页全年龄卡片：不触发额外 setRevealed，不产生新 Set 引用。
    view.rerender(<Harness cards={[...first, makeCard("g2", false), makeCard("g3", false)]} />);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(revealedHistory).toHaveLength(rendersBeforeAppend + 1);
    expect(revealedHistory.at(-1)).toBe(settledAfterFirst);

    // 再追加含新成人卡的一页：更新为包含全部成人卡的新 Set。
    view.rerender(<Harness cards={[...first, makeCard("g2", false), makeCard("a2", true)]} />);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    const settledAfterAdult = revealedHistory.at(-1)!;
    expect(settledAfterAdult).not.toBe(settledAfterFirst);
    expect(settledAfterAdult.has("a1")).toBe(true);
    expect(settledAfterAdult.has("a2")).toBe(true);
  });
});
