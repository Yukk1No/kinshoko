import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { FileDrop } from "../ipc/fileDrop";
import { CommandFailure } from "../ipc/commandError";
import { fakeBackend } from "../test/backend";
import { ImportBar } from "./ImportBar";

const { onDrop } = vi.hoisted(() => ({ onDrop: vi.fn() }));
vi.mock("../ipc/fileDrop", () => ({
  onFileDrop: async (handler: (drop: FileDrop) => void) => {
    onDrop(handler);
    return () => {};
  },
}));

it("shows the localized reason when a virtual image cannot be staged", async () => {
  fakeBackend();
  render(
    <ImportBar
      enabled
      libraryId="L1"
      libraryName="test"
      running={null}
      finished={null}
      onStarted={() => {}}
      onDismissReport={() => {}}
    />,
  );
  await waitFor(() => expect(onDrop).toHaveBeenCalled());
  act(() =>
    onDrop.mock.calls[0][0]({ kind: "error", error: new CommandFailure({ code: "imageDecode", detail: "bad image" }) }),
  );
  expect(await screen.findByText("无法读取拖入的图片：图片解码失败：bad image")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});
