import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageRating } from "../bindings/ImageRating";
import { SelectionPanel } from "./SelectionPanel";
import { fakeBackend } from "../test/backend";
import { tipText } from "../test/tip";

const NO_TAGS = { image: { imageId: "img", tags: [], rejected: [] }, identities: [] };

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
  fakeBackend({
    catalog_image_tags: NO_TAGS,
    image: initial,
    edit: (args) => {
      edits.push(args.edits);
      return [afterEdit];
    },
  });
  return edits;
}

function renderPanel() {
  render(
    <SelectionPanel libraryId="L1" selected={new Set(["img"])} onClear={() => {}} reloadKey={0} onError={() => {}} />,
  );
}

const stars = (rating: HTMLElement) =>
  within(rating)
    .getAllByRole("button")
    .map((b) => b.querySelector("svg")?.getAttribute("class") ?? null);

describe("选中一张图：内容分级（#518）", () => {
  it("自动分级：选中的就是模型给的那一档，只有它带星；没有说明行", async () => {
    const edits = backend(detail({}), detail({}));
    renderPanel();

    const rating = await screen.findByRole("group", { name: "内容分级" });
    expect(
      within(rating)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["false", "false", "false", "true"]);
    expect(stars(rating).map((star) => star !== null)).toEqual([false, false, false, true]);
    // 自动的星跟文字同色（没有 is-idle）。
    expect(stars(rating)[3]).not.toContain("is-idle");
    expect(within(rating).getByRole("button", { name: "成人，自动" })).toBeTruthy();
    expect(screen.queryByText(/自动分级|已手动修正/)).toBeNull();

    // 点已经生效的自动那一档，不记成画师的分级。
    fireEvent.click(within(rating).getByRole("button", { name: "成人，自动" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(edits).toEqual([]);
  });

  it("画师改成别的分级：选中的换到那一档，星留在模型给的那一档上、变淡", async () => {
    const edits = backend(detail({}), detail({ manual: "general", effective: "general" }));
    renderPanel();

    const rating = await screen.findByRole("group", { name: "内容分级" });
    fireEvent.click(within(rating).getByRole("button", { name: "全年龄" }));

    const revert = await within(rating).findByRole("button", { name: "成人，改回自动" });
    expect(edits).toEqual([[{ kind: "setRating", rating: "general" }]]);
    expect(
      within(rating)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["true", "false", "false", "false"]);
    expect(revert.querySelector("svg")!.getAttribute("class")).toContain("is-idle");
    expect(await tipText(revert)).toBe("改回自动");
    expect(screen.queryByText("已手动修正")).toBeNull();
  });

  it("没有自动分级时哪一档都不带星；画师选的那一档照常选中", async () => {
    backend(
      detail({ suggested: null, manual: null, effective: null }),
      detail({ suggested: null, manual: "sensitive", effective: "sensitive" }),
    );
    renderPanel();

    const rating = await screen.findByRole("group", { name: "内容分级" });
    expect(
      within(rating)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["false", "false", "false", "false"]);
    expect(stars(rating)).toEqual([null, null, null, null]);
    fireEvent.click(within(rating).getByRole("button", { name: "轻度" }));
    await waitFor(() =>
      expect(within(rating).getByRole("button", { name: "轻度" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(stars(rating)).toEqual([null, null, null, null]);
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

  it("点带星的那一档就是改回自动，不另放按钮", async () => {
    const edits = backend(detail({ manual: "general", effective: "general" }), detail({}));
    renderPanel();

    const rating = await screen.findByRole("group", { name: "内容分级" });
    expect(within(rating).getByRole("button", { name: "全年龄" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(rating).getAllByRole("button")).toHaveLength(4);
    fireEvent.click(within(rating).getByRole("button", { name: "成人，改回自动" }));

    await waitFor(() => expect(edits).toEqual([[{ kind: "revertRating" }]]));
    expect((await within(rating).findByRole("button", { name: "成人，自动" })).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("分级是属性表的最后一行，排在文件夹与备注之前；不在任何文件夹里时没有文件夹这一块", async () => {
    backend(detail({}), detail({}));
    renderPanel();
    const rating = await screen.findByRole("group", { name: "内容分级" });
    const row = rating.closest(".insp-prop")!;
    expect(row.querySelector("dt")!.textContent).toBe("分级");
    expect(row.parentElement!.lastElementChild).toBe(row);
    expect(screen.queryByRole("region", { name: "所在文件夹" })).toBeNull();
    expect(screen.queryByText("不在任何文件夹里")).toBeNull();
  });
});

it("当前选择的有效详情请求失败仍交给错误提示", async () => {
  const problems: string[] = [];
  fakeBackend({
    catalog_image_tags: NO_TAGS,
    image: () => Promise.reject("读取资料库失败"),
  });
  render(
    <SelectionPanel
      libraryId="L1"
      selected={new Set(["img"])}
      reloadKey={0}
      onClear={() => {}}
      onError={(message) => problems.push(String(message))}
    />,
  );
  await waitFor(() => expect(problems).toEqual(["读取资料库失败"]));
});

it("单张详情读失败后改成多选，标签面板照常出现", async () => {
  fakeBackend({
    image: () => Promise.reject({ code: "unknownImage" }),
    catalog_image_tags: NO_TAGS,
    workspace_sidebar: { all: 2, trash: 0, folders: [] },
  });
  const panel = (ids: string[]) => (
    <SelectionPanel libraryId="L1" selected={new Set(ids)} reloadKey={0} onClear={() => {}} onError={() => {}} />
  );
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
    expect(await tipText(line)).toBe(reason);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(edits).toEqual([[{ kind: "retryTagging" }]]));
    await waitFor(() => expect(screen.queryByText("自动标签未完成")).toBeNull());
  });

  it("选着的图之后打标失败：收到图片变化的通知就补上这一行，不用重新选", async () => {
    let failure: "unreadable" | null = null;
    fakeBackend({
      catalog_image_tags: NO_TAGS,
      image: () => ({ ...detail({}), taggingFailure: failure }),
    });
    const onError = () => {};
    const panel = (generation: number) => (
      <SelectionPanel
        libraryId="L1"
        selected={new Set(["img"])}
        onClear={() => {}}
        reloadKey={0}
        onError={onError}
        generation={generation}
      />
    );
    const view = render(panel(0));
    await screen.findByRole("group", { name: "内容分级" });
    expect(screen.queryByText("自动标签未完成")).toBeNull();
    failure = "unreadable";
    view.rerender(panel(1));
    expect(await screen.findByText("自动标签未完成")).toBeTruthy();
  });

  it("打完了的图没有这一行", async () => {
    backend(detail({}), detail({}));
    renderPanel();
    await screen.findByRole("group", { name: "内容分级" });
    expect(screen.queryByText("自动标签未完成")).toBeNull();
  });
});
