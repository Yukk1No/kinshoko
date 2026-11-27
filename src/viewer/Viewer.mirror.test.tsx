import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { Viewer } from "./Viewer";
import { SelectionPanel } from "../library/SelectionPanel";
import type { ImageDetail } from "../bindings/ImageDetail";
import { fakeBackend } from "../test/backend";

const NO_TAGS = { image: { imageId: "img", tags: [], rejected: [] }, identities: [] };
function detail(id: string): ImageDetail {
  return {
    id,
    originalName: `${id}.png`,
    width: 10,
    height: 10,
    folders: [],
    note: { manual: null, sources: [] },
    deletedAt: null,
    collectedAt: 0,
    sourceLinks: [],
    versions: { previous: null, newer: [] },
    taggingFailure: null,
    rating: { imageId: id, suggested: null, manual: null, effective: null },
  };
}

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

describe("查看器详情镜像（#794）", () => {
  it("查看器与详情侧栏共用同一份单图详情读取（#794）", async () => {
    const backend = fakeBackend({ image: detail("img"), catalog_image_tags: NO_TAGS });
    render(
      <>
        <Viewer
          libraryId="L1"
          card={{ id: "img", width: 2400, height: 1600, thumbnail: "", adult: false }}
          onClose={() => {}}
        />
        <SelectionPanel
          libraryId="L1"
          selected={new Set(["img"])}
          reloadKey={0}
          onClear={() => {}}
          onError={() => {}}
        />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText("img.png")).toHaveLength(2));
    expect(backend.calls("image")).toHaveLength(1);
  });

  it("reloadKey 前进与位图读取失败都会让详情镜像重新核对当前图（#794）", async () => {
    const backend = fakeBackend({ image: detail("a") });
    const view = render(
      <Viewer
        libraryId="L1"
        card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }}
        onClose={() => {}}
        reloadKey={0}
      />,
    );
    await waitFor(() => expect(backend.calls("image")).toHaveLength(1));

    view.rerender(
      <Viewer
        libraryId="L1"
        card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }}
        onClose={() => {}}
        reloadKey={1}
      />,
    );
    await waitFor(() => expect(backend.calls("image")).toHaveLength(2));

    fireEvent.error(screen.getByAltText("正在查看的参考图"));
    await waitFor(() => expect(backend.calls("image")).toHaveLength(3));
  });
});
