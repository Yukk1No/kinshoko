import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/Toast";

// 空桌上开了新参考组的提示（#595）。事件与 IPC 用替身。
const ipc = vi.hoisted(() => ({
  started: [] as Array<(started: { groupId: string; previousId: string }) => void>,
  group: vi.fn(),
  fold: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ipc", () => ({
  onDeskGroupStarted: (handler: (started: { groupId: string; previousId: string }) => void) => {
    ipc.started.push(handler);
    return Promise.resolve(() => {});
  },
  referenceGroup: ipc.group,
  foldIntoPrevious: ipc.fold,
}));

import { useDeskGroupStarted } from "./useDeskGroupStarted";

function Host() {
  useDeskGroupStarted();
  return null;
}

async function start(previousId: string) {
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  await act(async () => {
    for (const handler of ipc.started) handler({ groupId: "fresh", previousId });
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  ipc.started.length = 0;
});

describe("已开新参考组", () => {
  it("提示里“加进「上一组」”把提示所说的新参考组并回上一组", async () => {
    ipc.group.mockResolvedValue({ group: { id: "g1", name: "头发", createdAt: 0, updatedAt: 0, members: [] } });
    await start("g1");
    expect(await screen.findByText("已开新参考组")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "加进「头发」" }));
    });
    expect(ipc.fold).toHaveBeenCalledWith("fresh", "g1");
  });

  it("上一组读不出来时只提示，不带“加进”", async () => {
    ipc.group.mockRejectedValue({ code: "groupNotFound" });
    await start("gone");
    expect(await screen.findByText("已开新参考组")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^加进/ })).toBeNull();
  });
});
