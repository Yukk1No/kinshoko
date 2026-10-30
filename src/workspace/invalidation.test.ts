import { describe, expect, it } from "vitest";
import { decide, initialInvalidation, type InvalidationEvent, type InvalidationState } from "./invalidation";

/** 依次喂入事件，返回最后的状态与每一步的决定。 */
function run(events: InvalidationEvent[], from: InvalidationState = initialInvalidation) {
  let state = from;
  const decisions = events.map((event) => {
    const outcome = decide(state, event);
    state = outcome.state;
    return outcome.decision;
  });
  return { state, decisions, last: decisions[decisions.length - 1] };
}

/** 视角下已接受修订 r1 的状态。 */
function accepted(revision = "r1") {
  const { state } = run([{ kind: "statusRead" }]);
  return run([{ kind: "statusObserved", revision, origin: "read", startedAt: state.observations }], state).state;
}

describe("工作区失效决策", () => {
  it("视角下的第一份快照只采用，不关查看器、不重读", () => {
    const { state } = run([{ kind: "statusRead" }]);
    const { last } = run([{ kind: "statusObserved", revision: "r1", origin: "read", startedAt: state.observations }], state);
    expect(last).toMatchObject({ acceptStatus: true, closeViewer: false, reload: false, revokeWall: false });
  });

  it("同修订的重复通知只消重，不关掉刚打开的查看器", () => {
    const { decisions } = run([
      { kind: "statusObserved", revision: "r2", origin: "notification" },
      { kind: "statusObserved", revision: "r2", origin: "notification" },
    ], accepted());
    expect(decisions[0]).toMatchObject({ acceptStatus: true, revokeWall: true, closeViewer: true, reload: true, refreshVocabulary: true });
    expect(Object.values(decisions[1]).some(Boolean)).toBe(false);
  });

  it("迟到的初读不覆盖后来接受的通知", () => {
    const { state: reading } = run([{ kind: "statusRead" }]);
    const startedAt = reading.observations;
    const { state, last } = run([
      { kind: "statusObserved", revision: "r2", origin: "notification" },
      { kind: "statusObserved", revision: "r1", origin: "read", startedAt },
    ], reading);
    expect(last.acceptStatus).toBe(false);
    expect(state.revision).toBe("r2");
  });

  it("列表失效之后回来的初读同样作废", () => {
    const { state: reading } = run([{ kind: "statusRead" }]);
    const startedAt = reading.observations;
    const { last, decisions } = run([
      { kind: "listInvalidated" },
      { kind: "statusObserved", revision: "r1", origin: "read", startedAt },
    ], reading);
    expect(decisions[0]).toMatchObject({ revokeWall: true, reload: true, closeViewer: false, refreshVocabulary: false });
    expect(last.acceptStatus).toBe(false);
  });

  it("旧浏览页与新通知同批到达：哪个先到，最后都停在通知的修订，且只整套失效一次", () => {
    const pageFirst = run([
      { kind: "statusObserved", revision: "r1", origin: "page" },
      { kind: "statusObserved", revision: "r2", origin: "notification" },
    ], accepted());
    expect(pageFirst.state.revision).toBe("r2");
    expect(pageFirst.decisions.filter((d) => d.reload)).toHaveLength(1);

    const noticeFirst = run([
      { kind: "statusObserved", revision: "r2", origin: "notification" },
      { kind: "statusObserved", revision: "r2", origin: "page" },
    ], accepted());
    expect(noticeFirst.state.revision).toBe("r2");
    expect(noticeFirst.decisions.filter((d) => d.reload)).toHaveLength(1);
  });

  it("页带回的新修订先于通知到达：同样撤销查看器并重读，之后的同修订通知只消重", () => {
    const { decisions } = run([
      { kind: "statusObserved", revision: "r2", origin: "page" },
      { kind: "statusObserved", revision: "r2", origin: "notification" },
    ], accepted());
    expect(decisions[0]).toMatchObject({ acceptStatus: true, revokeWall: false, closeViewer: true, reload: true });
    expect(decisions[1].closeViewer).toBe(false);
  });

  it("修订号只比相同：字典序更小的新修订照样算前进", () => {
    const { state, last } = run([{ kind: "statusObserved", revision: "a0", origin: "notification" }], accepted("z9"));
    expect(last.acceptStatus).toBe(true);
    expect(state.revision).toBe("a0");
  });

  it("“重新连接”同修订仍重读一次，新修订走整套失效；期间有更新的事实就作废", () => {
    const base = accepted();
    const same = run([{ kind: "statusObserved", revision: "r1", origin: "recheck", startedAt: base.observations }], base);
    expect(same.last).toMatchObject({ reload: true, revokeWall: false, closeViewer: false, acceptStatus: false });
    const moved = run([{ kind: "statusObserved", revision: "r2", origin: "recheck", startedAt: base.observations }], base);
    expect(moved.last).toMatchObject({ acceptStatus: true, revokeWall: true, closeViewer: true, reload: true });
    const late = run([
      { kind: "listInvalidated" },
      { kind: "statusObserved", revision: "r2", origin: "recheck", startedAt: base.observations },
    ], base);
    expect(late.last.acceptStatus).toBe(false);
    expect(late.last.reload).toBe(false);
  });

  it("视角变化当即关查看器；按偏好清空选择或等新结果修剪", () => {
    const clear = run([{ kind: "lensChanged", keepSelection: false }]);
    expect(clear.last).toMatchObject({ closeViewer: true, clearSelection: true, clearSources: true, refreshVocabulary: true, reload: false });
    const keep = run([{ kind: "lensChanged", keepSelection: true }]);
    expect(keep.last).toMatchObject({ closeViewer: true, clearSelection: false, clearSources: false });
    expect(keep.state.prune).toBe("reset");
  });

  it("安全模式开启确认：按偏好清空选择、关查看器并重读；关闭确认不再重读（#183）", () => {
    expect(run([{ kind: "safeConfirmed", on: true, keepSelection: false }]).last)
      .toMatchObject({ clearSelection: true, closeViewer: true, reload: true, refreshVocabulary: true });
    expect(run([{ kind: "safeConfirmed", on: true, keepSelection: true }]).last.clearSelection).toBe(false);
    expect(Object.values(run([{ kind: "safeConfirmed", on: false, keepSelection: false }]).last).some(Boolean)).toBe(false);
  });

  it("修剪等新结果就绪：图片墙清空时先等读完，保留旧卡片时下一页到达就修剪，只修剪一次", () => {
    const emptied = run([
      { kind: "lensChanged", keepSelection: true },
      { kind: "pageAccepted", ready: false },
      { kind: "pageAccepted", ready: true },
      { kind: "pageAccepted", ready: true },
    ]);
    expect(emptied.decisions.map((d) => d.pruneSelection)).toEqual([false, false, true, false]);

    const kept = run([
      { kind: "statusObserved", revision: "r2", origin: "notification" },
      { kind: "pageAccepted", ready: true },
    ], accepted());
    expect(kept.last.pruneSelection).toBe(true);
    expect(kept.state.prune).toBe("idle");
  });

  it("普通修订刷新不清空选择，只交给修剪", () => {
    const { decisions } = run([{ kind: "statusObserved", revision: "r2", origin: "notification" }], accepted());
    expect(decisions[0].clearSelection).toBe(false);
    expect(decisions[0].clearSources).toBe(false);
  });

  it("没有失效时卡片变化不修剪", () => {
    expect(run([{ kind: "pageAccepted", ready: true }]).last.pruneSelection).toBe(false);
  });

  it("各调用方的动作组合由决策给出", () => {
    expect(run([{ kind: "cursorExpired" }]).last).toMatchObject({ reload: true, refreshVocabulary: true, closeViewer: false });
    expect(run([{ kind: "contentEdited" }]).last).toMatchObject({ reload: true, refreshVocabulary: true });
    expect(run([{ kind: "vocabularyInvalidated" }]).last).toMatchObject({ refreshVocabulary: true, reload: false });
    expect(run([{ kind: "scopeChanged" }]).last).toMatchObject({ clearSelection: true, clearSources: true, closeViewer: true, reload: false });
    expect(run([{ kind: "conditionsChanged" }]).last).toMatchObject({ clearSelection: true, clearSources: false, closeViewer: true });
    expect(run([{ kind: "activeLibraryChanged" }]).last).toMatchObject({ clearSelection: true, clearSources: true, closeViewer: true, reload: true });
  });
});
