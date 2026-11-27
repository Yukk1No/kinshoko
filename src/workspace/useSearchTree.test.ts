import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import { fakeBackend } from "../test/backend";
import { useSearchTree } from "./useSearchTree";

afterEach(cleanup);

const input: SearchInput = {
  conditions: [{ any: [{ kind: "text", text: "蓝", dismissed: [] }], negate: false }],
  exact: false,
};

const hookProps = (vocabularyKey: number) => ({
  safe: false,
  vocabularyKey,
  onError: () => {},
  setReloadKey: () => {},
  invalidate: () => {},
});

it("changeSearch 改查找条件，并恰好通知一次条件变了", () => {
  const invalidate = vi.fn();
  const { result } = renderHook(() =>
    useSearchTree({
      safe: false,
      vocabularyKey: 0,
      onError: () => {},
      setReloadKey: () => {},
      invalidate,
    }),
  );
  act(() => result.current.changeSearch({ conditions: [], exact: true }));
  expect(result.current.search.exact).toBe(true);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ kind: "conditionsChanged" });
});

it("workspace_resolve 遇到游标过期时重试，成功后交付条件树", async () => {
  let calls = 0;
  const fresh: ConditionTree = { conditions: [] };
  fakeBackend({
    workspace_resolve: () => {
      calls++;
      if (calls === 1) return Promise.reject({ code: "cursorExpired" });
      return fresh;
    },
  });
  const { result } = renderHook(() => useSearchTree(hookProps(1)));
  act(() => result.current.changeSearch(input));

  await waitFor(() => expect(result.current.tree).toBe(fresh));
  expect(calls).toBe(2);
});

it("词表重读时先发的旧解析迟到，不覆盖新解析", async () => {
  const pending: Array<(value: ConditionTree) => void> = [];
  fakeBackend({
    workspace_resolve: () =>
      new Promise<ConditionTree>((resolve) => {
        pending.push(resolve);
      }),
  });
  const view = renderHook(({ vocabularyKey }) => useSearchTree(hookProps(vocabularyKey)), {
    initialProps: { vocabularyKey: 0 },
  });
  act(() => view.result.current.changeSearch(input));
  await waitFor(() => expect(pending).toHaveLength(1));

  view.rerender({ vocabularyKey: 1 });
  await waitFor(() => expect(pending).toHaveLength(2));
  const oldTree: ConditionTree = { conditions: [] };
  const newTree: ConditionTree = { conditions: [] };
  await act(async () => pending[1](newTree));
  await waitFor(() => expect(view.result.current.tree).toBe(newTree));

  await act(async () => pending[0](oldTree));
  expect(view.result.current.tree).toBe(newTree);
});

it("安全模式切换后，旧视角的树只留在旧视角标记下；新解析到达才换标记", async () => {
  const pending: Array<(value: ConditionTree) => void> = [];
  fakeBackend({
    workspace_resolve: () =>
      new Promise<ConditionTree>((resolve) => {
        pending.push(resolve);
      }),
  });
  const view = renderHook(
    ({ safe }) =>
      useSearchTree({
        ...hookProps(0),
        safe,
      }),
    { initialProps: { safe: false } },
  );
  act(() => view.result.current.changeSearch(input));
  await waitFor(() => expect(pending).toHaveLength(1));
  const oldTree: ConditionTree = { conditions: [] };
  await act(async () => pending[0](oldTree));
  await waitFor(() => expect(view.result.current.tree).toBe(oldTree));
  expect(view.result.current.treeSafe).toBe(false);

  view.rerender({ safe: true });
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(view.result.current.tree).toBe(oldTree);
  expect(view.result.current.treeSafe).toBe(false);
  const newTree: ConditionTree = { conditions: [] };
  await act(async () => pending[1](newTree));
  await waitFor(() => expect(view.result.current.tree).toBe(newTree));
  expect(view.result.current.treeSafe).toBe(true);
});
