import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { Viewer } from "./Viewer";
import { fakeBackend } from "../test/backend";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  mockConvertFileSrc("windows");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("查看器生命周期（#716）", () => {
  it("StrictMode 开发态挂载后，当前图的 unknownImage 仍会关闭查看器（#716）", async () => {
    let rejectPin: (reason?: unknown) => void = () => {};
    fakeBackend({
      image: {},
      pin_reference: () =>
        new Promise((_, reject) => {
          rejectPin = reject;
        }),
    });
    const close = vi.fn();
    render(
      <Viewer
        libraryId="L1"
        card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }}
        onClose={close}
      />,
      { reactStrictMode: true },
    );
    fireEvent.keyDown(screen.getByAltText("正在查看的参考图").parentElement!, { key: "p" });
    await act(async () => {
      rejectPin({ code: "unknownImage" });
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("查看器关闭后钉图失败，错误仍进全局提示（#716）", async () => {
    let rejectPin: (reason?: unknown) => void = () => {};
    fakeBackend({
      image: {},
      pin_reference: () =>
        new Promise((_, reject) => {
          rejectPin = reject;
        }),
    });
    function Harness({ show }: { show: boolean }) {
      return show ? (
        <Viewer
          libraryId="L1"
          card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }}
          onClose={() => {}}
        />
      ) : null;
    }
    const view = render(<Harness show />);
    fireEvent.keyDown(screen.getByAltText("正在查看的参考图").parentElement!, { key: "p" });
    view.rerender(<Harness show={false} />);
    await act(async () => {
      rejectPin({ code: "message", message: "写不进" });
      await Promise.resolve();
    });
    expect(await screen.findByText("无法钉住：写不进")).toBeTruthy();
  });

  it("当前图详情读出 unknownImage 时关闭查看器（#794）", async () => {
    fakeBackend({ image: () => Promise.reject({ code: "unknownImage" }) });
    const close = vi.fn();
    render(
      <Viewer
        libraryId="L1"
        card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }}
        onClose={close}
      />,
    );

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("切到下一张后，上一张详情迟到的 unknownImage 不关闭当前查看器（#794）", async () => {
    let rejectFirst: (reason?: unknown) => void = () => {};
    const backend = fakeBackend({
      image: (args) => {
        if (args.imageId === "a")
          return new Promise((_, reject) => {
            rejectFirst = reject;
          });
        return { originalName: "b.png" };
      },
    });
    const close = vi.fn();
    const view = render(
      <Viewer
        libraryId="L1"
        card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }}
        onClose={close}
      />,
    );
    await waitFor(() => expect(backend.calls("image")).toHaveLength(1));

    view.rerender(
      <Viewer
        libraryId="L1"
        card={{ id: "b", width: 2400, height: 1600, thumbnail: "", adult: false }}
        onClose={close}
      />,
    );
    await waitFor(() => expect(backend.calls("image")).toHaveLength(2));
    await act(async () => {
      rejectFirst({ code: "unknownImage" });
      await Promise.resolve();
    });

    expect(close).not.toHaveBeenCalled();
  });
});
