import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageRating } from "../bindings/ImageRating";
import { SelectionPanel } from "./SelectionPanel";

afterEach(() => {
  cleanup();
  clearMocks();
});

function detail(rating: Partial<ImageRating>): ImageDetail {
  return {
    id: "img",
    width: 10,
    height: 10,
    folders: [],
    note: { manual: null, sources: [] },
    deletedAt: null,
    rating: { imageId: "img", suggested: "explicit", manual: null, effective: "explicit", ...rating },
  };
}

function backend(initial: ImageDetail, afterEdit: ImageDetail) {
  const edits: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|sidebar") return { all: 1, trash: 0, folders: [] };
    if (cmd === "plugin:library|image") return initial;
    if (cmd === "plugin:library|edit") {
      edits.push((args as { edits: unknown }).edits);
      return [afterEdit];
    }
    return undefined;
  });
  return edits;
}

function renderPanel() {
  render(
    <SelectionPanel
      libraryId="L1"
      scope={{ kind: "all" }}
      selected={new Set(["img"])}
      onClear={() => {}}
      reloadKey={0}
      onError={() => {}}
    />,
  );
}

describe("选中一张图：内容分级", () => {
  it("显示自动分级，画师改成别的分级后标明是人工修正", async () => {
    const edits = backend(
      detail({}),
      detail({ manual: "general", effective: "general" }),
    );
    renderPanel();

    const select = (await screen.findByRole("combobox", { name: "内容分级" })) as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe("自动（露骨）");

    fireEvent.change(select, { target: { value: "general" } });

    expect(await screen.findByText("人工修正，重新打标不会覆盖")).toBeTruthy();
    expect(edits).toEqual([[{ kind: "setRating", rating: "general" }]]);
  });

  it("安全模式下改成含成人内容的分级，图被封印，随即取消选择", async () => {
    backend(
      detail({ suggested: "general", effective: "general" }),
      detail({ suggested: "general", manual: "explicit", effective: "explicit" }),
    );
    let cleared = false;
    render(
      <SelectionPanel
        libraryId="L1"
        scope={{ kind: "all" }}
        selected={new Set(["img"])}
        onClear={() => (cleared = true)}
        reloadKey={0}
        onError={() => {}}
        safeMode
      />,
    );

    const select = await screen.findByRole("combobox", { name: "内容分级" });
    fireEvent.change(select, { target: { value: "explicit" } });

    await waitFor(() => expect(cleared).toBe(true));
  });

  it("选回自动即退回自动分级", async () => {
    const edits = backend(detail({ manual: "general", effective: "general" }), detail({}));
    renderPanel();

    const select = await screen.findByRole("combobox", { name: "内容分级" });
    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => expect(edits).toEqual([[{ kind: "revertRating" }]]));
    await waitFor(() => expect(screen.queryByText("人工修正，重新打标不会覆盖")).toBeNull());
  });
});
