import { describe, expect, it } from "vitest";
import type { BrowserCard } from "../wall/wallShared";
import {
  acceptBrowsePage,
  applyBrowseEvent,
  beginBrowse,
  initialBrowseResults,
  type BrowseResultsState,
  type BrowseView,
} from "./browseResults";

const card = (id: string): BrowserCard => ({
  id,
  width: 100,
  height: 100,
  adult: false,
  libraryId: "L",
  imageId: id,
  sources: [],
});
const status = (revision: string) => ({ revision, libraries: [] });
const ids = (cards: readonly BrowserCard[]) => cards.map((item) => item.id);

function accepted(revision = "r1") {
  return applyBrowseEvent(initialBrowseResults, {
    kind: "statusObserved",
    status: status(revision),
    origin: "mirror",
  }).state;
}

function viewOf(state: BrowseResultsState): BrowseView {
  return { selected: state.selected, viewerOpen: state.viewerOpen };
}

describe("浏览结果原子交付", () => {
  it("旧页与新通知同批到达：旧页被拒绝，最终显示重读页、查看器留着并修剪选择", () => {
    let state = accepted();
    const old = beginBrowse(state);
    state = old.state;

    const notice = applyBrowseEvent(
      state,
      { kind: "statusObserved", status: status("r2"), origin: "notification" },
      { selected: new Set(["keep", "drop"]), viewerOpen: true },
    );
    state = notice.state;
    expect(notice.decision).toMatchObject({ revokeWall: true, closeViewer: false, reload: true });

    const stale = acceptBrowsePage(
      state,
      { token: old.token, status: status("r1"), cards: [card("old")], total: 1 },
      { selected: new Set(["keep", "drop"]), viewerOpen: true },
    );
    expect(stale.acceptedPage).toBe(false);
    expect(stale.state).toBe(state);

    const reread = beginBrowse(state);
    const fresh = acceptBrowsePage(
      reread.state,
      { token: reread.token, status: status("r2"), cards: [card("keep")], total: 1 },
      viewOf(state),
    );
    expect(fresh.acceptedPage).toBe(true);
    expect(fresh.decision.pruneSelection).toBe(true);
    expect(fresh.state.status?.revision).toBe("r2");
    expect(ids(fresh.state.cards)).toEqual(["keep"]);
    expect(fresh.state.total).toBe(1);
    expect([...fresh.state.selected]).toEqual(["keep"]);
    expect(fresh.state.viewerOpen).toBe(true);
  });

  it("旧页先落、通知紧随其后：最终仍只显示通知后的重读页", () => {
    let state = accepted();
    const old = beginBrowse(state);
    const opened = { selected: new Set(["old", "keep"]), viewerOpen: true };
    const oldPage = acceptBrowsePage(
      old.state,
      { token: old.token, status: status("r1"), cards: [card("old"), card("keep")], total: 2 },
      opened,
    );
    expect(oldPage.acceptedPage).toBe(true);
    state = oldPage.state;
    expect(ids(state.cards)).toEqual(["old", "keep"]);

    const notice = applyBrowseEvent(
      state,
      { kind: "statusObserved", status: status("r2"), origin: "notification" },
      opened,
    );
    state = notice.state;
    expect(state.viewerOpen).toBe(true);

    const reread = beginBrowse(state);
    const fresh = acceptBrowsePage(
      reread.state,
      { token: reread.token, status: status("r2"), cards: [card("keep")], total: 1 },
      viewOf(state),
    );
    expect(fresh.state.status?.revision).toBe("r2");
    expect(ids(fresh.state.cards)).toEqual(["keep"]);
    expect(fresh.state.total).toBe(1);
    expect([...fresh.state.selected]).toEqual(["keep"]);
    expect(fresh.state.viewerOpen).toBe(true);
  });

  it("游标过期触发重读；带回新修订的页原子完成换页、选择修剪，查看器留着", () => {
    let state = accepted();
    const first = beginBrowse(state);
    const initial = acceptBrowsePage(
      first.state,
      { token: first.token, status: status("r1"), cards: [card("keep"), card("drop")], total: 2 },
      { selected: new Set(["keep", "drop"]), viewerOpen: true },
    );
    state = initial.state;

    const expired = applyBrowseEvent(state, { kind: "cursorExpired" }, viewOf(state));
    expect(expired.decision).toMatchObject({ reload: true, refreshVocabulary: true, closeViewer: false });
    state = expired.state;

    const reread = beginBrowse(state);
    const fresh = acceptBrowsePage(
      reread.state,
      { token: reread.token, status: status("r2"), cards: [card("keep")], total: 1 },
      viewOf(state),
    );
    expect(fresh.acceptedPage).toBe(true);
    expect(fresh.decision.closeViewer).toBe(false);
    expect(fresh.decision.pruneSelection).toBe(true);
    expect(fresh.state.status?.revision).toBe("r2");
    expect(ids(fresh.state.cards)).toEqual(["keep"]);
    expect(fresh.state.total).toBe(1);
    expect([...fresh.state.selected]).toEqual(["keep"]);
    expect(fresh.state.viewerOpen).toBe(true);
  });
});
