import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageRating } from "../bindings/ImageRating";
import { SelectionPanel } from "./SelectionPanel";

const NO_TAGS = { image: { imageId: "img", tags: [], rejected: [] }, identities: [] };

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
    taggingFailure: null,
    rating: { imageId: "img", suggested: "explicit", manual: null, effective: "explicit", ...rating },
  };
}

function backend(initial: ImageDetail, afterEdit: ImageDetail) {
  const edits: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:library|catalog_image_tags") return NO_TAGS;
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

    const rating = await screen.findByRole("group", { name: "内容分级" });
    expect(screen.getByText("自动分级：成人")).toBeTruthy();
    expect(within(rating).getAllByRole("button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false"]);

    fireEvent.click(within(rating).getByRole("button", { name: "全年龄" }));

    expect(await screen.findByText("已手动修正")).toBeTruthy();
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
        selected={new Set(["img"])}
        onClear={() => (cleared = true)}
        reloadKey={0}
        onError={() => {}}
        safeMode
      />,
    );

    const rating = await screen.findByRole("group", { name: "内容分级" });
    fireEvent.click(within(rating).getByRole("button", { name: "成人" }));

    await waitFor(() => expect(cleared).toBe(true));
  });

  it("改回自动即退回自动分级", async () => {
    const edits = backend(detail({ manual: "general", effective: "general" }), detail({}));
    renderPanel();

    const rating = await screen.findByRole("group", { name: "内容分级" });
    expect(within(rating).getByRole("button", { name: "全年龄" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /改回自动/ }));

    await waitFor(() => expect(edits).toEqual([[{ kind: "revertRating" }]]));
    await waitFor(() => expect(screen.queryByText("已手动修正")).toBeNull());
  });
});


it("当前选择的有效详情请求失败仍交给错误提示", async () => {
  const problems: string[] = [];
  mockIPC((command) => {
    if (command === "plugin:library|catalog_image_tags") return NO_TAGS;
    if (command === "plugin:library|image") return Promise.reject("读取资料库失败");
    return undefined;
  });
  render(<SelectionPanel libraryId="L1" selected={new Set(["img"])}
    reloadKey={0} onClear={() => {}} onError={(message) => problems.push(String(message))} />);
  await waitFor(() => expect(problems).toEqual(["读取资料库失败"]));
});

it("单张详情读失败后改成多选，标签面板照常出现", async () => {
  mockIPC((command) => {
    if (command === "plugin:library|image") return Promise.reject({ code: "unknownImage" });
    if (command === "plugin:library|catalog_image_tags") return NO_TAGS;
    if (command === "plugin:library|workspace_sidebar") return { all: 2, trash: 0, folders: [] };
    return [];
  });
  const panel = (ids: string[]) => <SelectionPanel libraryId="L1" selected={new Set(ids)}
    reloadKey={0} onClear={() => {}} onError={() => {}} />;
  const view = render(panel(["a"]));
  await waitFor(() => expect(screen.queryByRole("region", { name: "标签" })).toBeNull());
  view.rerender(panel(["a", "b"]));
  expect(await screen.findByRole("region", { name: "标签" })).toBeTruthy();
});

describe("选中一张图：自动标签未完成（#475）", () => {
  it.each<["unreadable" | "crashed", string]>([
    ["unreadable", "无法读取这张图"],
    ["crashed", "处理这张图时出错"],
  ])("写出未完成，原因在悬停提示；重试后这一行收起", async (failure, reason) => {
    const edits = backend({ ...detail({}), taggingFailure: failure }, detail({}));
    renderPanel();
    const line = await screen.findByText("自动标签未完成");
    expect(line.getAttribute("title")).toBe(reason);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(edits).toEqual([[{ kind: "retryTagging" }]]));
    await waitFor(() => expect(screen.queryByText("自动标签未完成")).toBeNull());
  });

  it("打完了的图没有这一行", async () => {
    backend(detail({}), detail({}));
    renderPanel();
    await screen.findByRole("group", { name: "内容分级" });
    expect(screen.queryByText("自动标签未完成")).toBeNull();
  });
});
