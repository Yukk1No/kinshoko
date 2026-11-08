import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useStackSetsSetting } from "./imageSets";

// 「叠放图集」开关（#418）：切换后墙重新挂载、页的格子变了，原来的选择可能落在看不见的页上。
it("切换叠放图集时通知调用方清掉选择", () => {
  const onToggle = vi.fn();
  const { result } = renderHook(() => useStackSetsSetting(onToggle));
  expect(result.current.on).toBe(true);
  act(() => result.current.menu!.toggle());
  expect(result.current.on).toBe(false);
  expect(onToggle).toHaveBeenCalledTimes(1);
});
