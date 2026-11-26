import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { fakeBackend } from "../test/backend";
import { subscription } from "./subscriptions.fixtures";
import {
  acceptAddedLocalSubscriptions,
  invalidateLocalSubscriptions,
  useLocalSubscriptions,
} from "./subscriptionListMirror";

describe("本机订阅名单镜像", () => {
  it("写入后的重读抢先带回了新订阅时，接受写入结果不再加一遍", async () => {
    const existing = subscription("s1", "Mika");
    const added = subscription("s2", "山田");
    let stored = [existing];
    const backend = fakeBackend({ subscriptions: () => stored });
    const view = renderHook(() => useLocalSubscriptions());
    await vi.waitFor(() => expect(view.result.current.value).toHaveLength(1));

    stored = [existing, added];
    act(() => invalidateLocalSubscriptions());
    await vi.waitFor(() => expect(view.result.current.value).toHaveLength(2));
    act(() => acceptAddedLocalSubscriptions([added]));

    expect(view.result.current.value?.map((sub) => sub.id)).toEqual(["s1", "s2"]);
    expect(backend.calls("subscriptions")).toHaveLength(2);
    view.unmount();
  });
});
