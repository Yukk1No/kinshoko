import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSearchTree } from "./useSearchTree";

afterEach(cleanup);

it("changeSearch 改查找条件，并恰好通知一次条件变了", () => {
  const invalidate = vi.fn();
  const { result } = renderHook(() => useSearchTree({
    safe: false, vocabularyKey: 0, onError: () => {}, setReloadKey: () => {}, invalidate,
  }));
  act(() => result.current.changeSearch({ conditions: [], exact: true }));
  expect(result.current.search.exact).toBe(true);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ kind: "conditionsChanged" });
});
