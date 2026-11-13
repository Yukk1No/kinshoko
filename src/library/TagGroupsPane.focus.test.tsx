import { beforeEach, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import { fakeBackend } from "../test/backend";
import { TagGroupsPane } from "./TagGroupsPane";
import { ToastProvider } from "../ui/Toast";

const tag = (id: string, name: string) => ({ tag: { id, namespace: "general" as const, name, untranslated: false, hasExternal: false }, count: 1 });
let groups: CatalogGroupView[];

beforeEach(() => {
  groups = [
    { id: "A", name: "发色", namespace: null, tags: [tag("t1", "蓝发"), tag("t2", "紫发")], sources: [] },
    { id: "B", name: "服装", namespace: null, tags: [], sources: [] },
    { id: "C", name: "姿势", namespace: null, tags: [], sources: [] },
  ];
  fakeBackend({
    shared_tag_groups: () => structuredClone(groups),
    edit_shared_tag_group: (payload) => {
      const edit = payload.edit as CatalogGroupEdit;
      if (edit.kind === "orderGroups") groups = edit.groupIds.map((id) => groups.find((g) => g.id === id)!);
      if (edit.kind === "orderMembers") groups = groups.map((g) => g.id === edit.groupId ? { ...g, tags: edit.tagIds.map((id) => g.tags.find((t) => t.tag.id === id)!) } : g);
      if (edit.kind === "removeMembers") groups = groups.map((g) => g.id === edit.groupId ? { ...g, tags: g.tags.filter((t) => !edit.tagIds.includes(t.tag.id)) } : g);
      return null;
    },
    delete_shared_tag_group: (payload) => {
      const id = payload.groupId as string;
      const ord = groups.findIndex((g) => g.id === id);
      const [gone] = groups.splice(ord, 1);
      return { id, name: gone.name, namespace: null, ord, members: [], migratedFrom: [] };
    },
  });
});

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
  render(<ToastProvider><TagGroupsPane safe={false} generation={0} onBrowse={() => {}} onError={() => {}} /></ToastProvider>);
  await press("下移标签分组“发色”");
  await waitFor(() => expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["服装", "发色", "姿势"]));
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("下移标签分组“发色”");

  await press("把“蓝发”在“发色”中后移");
  await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute("aria-label")).not.toBeNull());
  // 移到最后一位后“后移”不可用：焦点落在同一成员的“前移”。
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("把“蓝发”在“发色”中前移");
});

it("移出成员后，焦点落在所在分组上，不丢到页面", async () => {
  render(<ToastProvider><TagGroupsPane safe={false} generation={0} onBrowse={() => {}} onError={() => {}} /></ToastProvider>);
  await press("把“紫发”移出“发色”");
  await waitFor(() => expect(screen.queryByRole("button", { name: "把“紫发”移出“发色”" })).toBeNull());
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("发色（1 个标签）");
});

it("用键盘删除分组后，焦点落在相邻分组上，不跳到“新建分组”", async () => {
  render(<ToastProvider><TagGroupsPane safe={false} generation={0} onBrowse={() => {}} onError={() => {}} /></ToastProvider>);
  await press("删除标签分组“服装”");
  await waitFor(() => expect(screen.queryByRole("group", { name: "服装" })).toBeNull());
  // 姿势没有成员，名称按钮不可用，焦点退到它的其他操作；总之在相邻分组里。
  expect(screen.getByRole("group", { name: "姿势" }).contains(document.activeElement)).toBe(true);
});
