import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    originalName: "img.png",
    width: 10,
    height: 10,
    folders: [],
    note: { manual: null, sources: [] },
    deletedAt: null,
    collectedAt: 0,
    sourceLinks: [],
    versions: { previous: null, newer: [] },
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


it("永久删除确认使旧详情请求失效，删除后迟到的缺失错误不进入全局提示", async () => {
  let fail!: (error: string) => void;
  const pending = new Promise<ImageDetail>((_, reject) => { fail = reject; });
  const problems: string[] = [];
  mockIPC((command) => {
    if (command === "plugin:library|sidebar") return { all: 0, trash: 1, folders: [] };
    if (command === "plugin:library|image") return pending;
    if (command === "plugin:library|preview_permanent_delete") return { imageIds: ["img"], token: "t", groups: [] };
    return undefined;
  });
  render(<SelectionPanel libraryId="L1" scope={{ kind: "trash" }} selected={new Set(["img"])}
    reloadKey={0} onClear={() => {}} onError={(message) => problems.push(message)} />);
  fireEvent.click(screen.getByRole("button", { name: "永久删除…" }));
  await screen.findByRole("button", { name: "确认永久删除" });
  await act(async () => { fail("资料库中没有这张参考图"); await pending.catch(() => {}); });
  expect(problems).toEqual([]);
});

it("当前选择的有效详情请求失败仍交给错误提示", async () => {
  const problems: string[] = [];
  mockIPC((command) => {
    if (command === "plugin:library|sidebar") return { all: 1, trash: 0, folders: [] };
    if (command === "plugin:library|image") return Promise.reject("读取资料库失败");
    return undefined;
  });
  render(<SelectionPanel libraryId="L1" scope={{ kind: "all" }} selected={new Set(["img"])}
    reloadKey={0} onClear={() => {}} onError={(message) => problems.push(message)} />);
  await waitFor(() => expect(problems).toEqual(["读取资料库失败"]));
});
