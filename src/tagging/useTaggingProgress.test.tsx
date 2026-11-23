import { act, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { expect, it } from "vitest";
import { fakeBackend } from "../test/backend";
import { useTaggingStatus } from "./useTaggingStatus";
import { useTaggingProgress } from "./useTaggingProgress";

it("shares remaining with a progress observer mounted after pausing and clears unknown states", async () => {
  fakeBackend({ tagging_status: { state: "paused" } });
  const first = renderHook(() => useTaggingProgress(useTaggingStatus()));
  await act(async () => {});
  expect(first.result.current.remaining).toBeNull();
  await act(() =>
    emit("tagging-status", {
      state: "running",
      model: "x",
      device: "cpu",
      gpu: null,
      tagged: 5,
      done: 5,
      remaining: 138,
    }),
  );
  await act(() => emit("tagging-status", { state: "paused" }));
  const second = renderHook(() => useTaggingProgress(useTaggingStatus()));
  await act(async () => {});
  expect(second.result.current.remaining).toBe(138);
  expect(first.result.current.remaining).toBe(138);
  await act(() => emit("tagging-status", { state: "failed", reason: { code: "downloadFailed", detail: "timeout" } }));
  expect(first.result.current.remaining).toBeNull();
  expect(second.result.current.remaining).toBeNull();
});
