import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import { TagGroupsPane } from "./TagGroupsPane";

const tag = (id: string, name: string) => ({ tag: { id, namespace: "general" as const, name, untranslated: false, hasExternal: false }, count: 1 });
let groups: CatalogGroupView[];

beforeEach(() => {
  groups = [
    { id: "A", name: "发色", namespace: null, tags: [tag("t1", "蓝发"), tag("t2", "紫发")], sources: [] },
    { id: "B", name: "服装", namespace: null, tags: [], sources: [] },
    { id: "C", name: "姿势", namespace: null, tags: [], sources: [] },
  ];
  mockIPC((command, payload) => {
    if (command === "plugin:library|shared_tag_groups") return structuredClone(groups);
    if (command === "plugin:library|edit_shared_tag_group") {
      const edit = (payload as { edit: CatalogGroupEdit }).edit;
      if (edit.kind === "orderGroups") groups = edit.groupIds.map((id) => groups.find((g) => g.id === id)!);
      if (edit.kind === "orderMembers") groups = groups.map((g) => g.id === edit.groupId ? { ...g, tags: edit.tagIds.map((id) => g.tags.find((t) => t.tag.id === id)!) } : g);
      if (edit.kind === "removeMembers") groups = groups.map((g) => g.id === edit.groupId ? { ...g, tags: g.tags.filter((t) => !edit.tagIds.includes(t.tag.id)) } : g);
      return null;
    }
    return null;
  });
});
afterEach(() => { cleanup(); clearMocks(); });

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function press(name: string) {
  const button = await screen.findByRole("button", { name });
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  await settle();
  await settle();
}

it("编辑分组的操作完成、列表刷新后，键盘焦点回到同一个操作上", async () => {
  render(<TagGroupsPane safe={false} generation={0} onBrowse={() => {}} onError={() => {}} />);
  await press("下移标签分组“发色”");
  await waitFor(() => expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["服装", "发色", "姿势"]));
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("下移标签分组“发色”");

  await press("下移“蓝发”在“发色”中的顺序");
  await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute("aria-label")).not.toBeNull());
  // 移到最后一位后“下移”不可用：焦点落在同一成员的“上移”。
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("上移“蓝发”在“发色”中的顺序");
});

it("移出成员后，焦点落在所在分组上，不丢到页面", async () => {
  render(<TagGroupsPane safe={false} generation={0} onBrowse={() => {}} onError={() => {}} />);
  await press("把“紫发”移出“发色”");
  await waitFor(() => expect(screen.queryByRole("button", { name: "把“紫发”移出“发色”" })).toBeNull());
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("发色（1 个标签）");
});
