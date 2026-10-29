// #158：连续切换选中图时，详情面板只读和这张图有关的内容，切换中不闪空白。
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { CatalogImageTags } from "../bindings/CatalogImageTags";
import { SelectionPanel } from "./SelectionPanel";
import { WorkspaceSources } from "./WorkspacePane";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

afterEach(() => {
  cleanup();
  clearMocks();
});

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
    rating: { imageId: id, suggested: null, manual: null, effective: null },
  };
}

function tags(id: string): CatalogImageTags {
  const tag = { id: `t-${id}`, namespace: "general" as const, name: `${id} 的标签`, untranslated: false, hasExternal: false };
  return { image: { imageId: id, tags: [{ tag, origins: [{ kind: "manual" }] }], rejected: [] }, identities: [] };
}

/** 记下每条命令发了几次；`answer` 可以给某张图的回答换成未完成的 Promise。 */
function backend(answer: (cmd: string, id: string) => unknown = () => undefined) {
  const calls: Record<string, number> = {};
  mockIPC((cmd, args) => {
    const name = cmd.replace("plugin:library|", "");
    calls[name] = (calls[name] ?? 0) + 1;
    const id = (args as { imageId?: string }).imageId ?? "";
    const custom = answer(name, id);
    if (custom !== undefined) return custom;
    if (name === "workspace_sidebar" || name === "sidebar") return { all: 3, trash: 0, folders: [{ id: "f", name: "人物", count: 1, children: [] }] };
    if (name === "image") return detail(id);
    if (name === "catalog_image_tags") return tags(id);
    if (name === "image_tags") return tags(id).image;
    return undefined;
  });
  return calls;
}

function panel(id: string) {
  return (
    <SelectionPanel workspace libraryId="L1" scope={{ kind: "all" }} selected={new Set([id])}
      onClear={() => {}} reloadKey={0} onError={() => {}} />
  );
}

it("连续切换选中图时，不再重新读取文件夹树", async () => {
  const calls = backend();
  const view = render(panel("a"));
  await screen.findByText("a.png");
  view.rerender(panel("b"));
  await screen.findByText("b.png");
  view.rerender(panel("c"));
  await screen.findByText("c.png");
  await screen.findByText("c 的标签");

  expect(calls.workspace_sidebar).toBe(1);
});

it("一次选中，详情和标签的后端查询各只发一次", async () => {
  const calls = backend();
  render(panel("a"));
  await screen.findByText("a.png");
  await screen.findByText("a 的标签");

  expect(calls.image).toBe(1);
  // image_tags 与 catalog_image_tags 在后端是同一个查询（统一标签目录读这张图的标签）。
  expect((calls.image_tags ?? 0) + (calls.catalog_image_tags ?? 0)).toBe(1);
});

function deferred() {
  const pending: Record<string, (value: unknown) => void> = {};
  const answer = (cmd: string, id: string) => {
    if (id === "a" || (cmd !== "image" && cmd !== "catalog_image_tags")) return undefined;
    return new Promise((resolve) => { pending[`${cmd}/${id}`] = resolve; });
  };
  const finish = async (id: string) => {
    await act(async () => {
      pending[`image/${id}`](detail(id));
      pending[`catalog_image_tags/${id}`](tags(id));
    });
  };
  return { answer, finish };
}

it("切换选中图时，新内容到达前面板保留上一张的详情和标签，不是空白", async () => {
  const later = deferred();
  backend(later.answer);
  const view = render(panel("a"));
  await screen.findByText("a.png");
  await screen.findByText("a 的标签");

  view.rerender(panel("b"));

  expect(screen.getByText("a.png")).toBeTruthy();
  expect(screen.getByText("a 的标签")).toBeTruthy();
  await later.finish("b");
  expect(screen.getByText("b.png")).toBeTruthy();
  expect(screen.getByText("b 的标签")).toBeTruthy();
  expect(screen.queryByText("a.png")).toBeNull();
});

it("迟到的旧响应不会写进新选中的图", async () => {
  const later = deferred();
  backend(later.answer);
  const view = render(panel("a"));
  await screen.findByText("a.png");
  view.rerender(panel("b"));
  view.rerender(panel("c"));

  await later.finish("c");
  await later.finish("b");

  await waitFor(() => expect(screen.getByText("c.png")).toBeTruthy());
  expect(screen.getByText("c 的标签")).toBeTruthy();
  expect(screen.queryByText("b.png")).toBeNull();
  expect(screen.queryByText("b 的标签")).toBeNull();
});

it("跨库视角下，一次选中只调用一次 workspaceSourceInspection", async () => {
  const calls: Record<string, number> = {};
  mockIPC((cmd, args) => {
    calls[cmd] = (calls[cmd] ?? 0) + 1;
    const id = (args as { target?: { imageId: string } }).target?.imageId ?? "";
    if (cmd === "plugin:library|workspace_source_inspection") return { detail: detail(id), tags: tags(id), sidebar: { all: 1, trash: 0, folders: [] } };
    if (cmd === "plugin:library|workspace_sidebar") return { all: 1, trash: 0, folders: [] };
    if (cmd === "plugin:desktop|reference_groups") return [];
    return undefined;
  });
  const card: WorkspaceCard = { id: "same-bytes", width: 10, height: 10, adult: false, libraryId: "B", imageId: "b", sources: [
    { libraryId: "B", libraryName: "移动盘参考", imageId: "b", matches: true, unavailable: null, deleted: false },
  ] };
  render(<WorkspaceSources card={card} onClose={() => {}} onView={() => {}} />);
  screen.getByRole("button", { name: "整理此来源" }).click();
  await screen.findByText("b.png");
  await screen.findByText("b 的标签");

  expect(calls["plugin:library|workspace_source_inspection"]).toBe(1);
  // 来源检查已经带着文件夹树。
  expect(calls["plugin:library|workspace_sidebar"] ?? 0).toBe(0);
});
