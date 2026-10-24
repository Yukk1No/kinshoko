import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { App } from "../App";
import { fake, sent, card, selectOnly } from "./TagOrganize.fixtures";
import { chooseValue } from "../test/select";

async function openGroups() {
  fireEvent.click(await screen.findByRole("button", { name: "编辑分组" }));
  return screen.findByRole("region", { name: "标签分组" });
}
async function closeGroups() {
  fireEvent.click(within(screen.getByRole("dialog", { name: "编辑分组" })).getByRole("button", { name: "完成" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑分组" })).toBeNull());
}

describe("标签分组", () => {
  it("建立全局分组、从统一标签挑成员，侧栏按分组列出计数；点标签按它浏览", async () => {
    render(<App />);
    const groups = await openGroups();
    // The region appears before its first group refresh settles; the create button stays disabled until then.
    const create = await waitFor(() => {
      const button = within(groups).getByRole<HTMLButtonElement>("button", { name: "新建标签分组" });
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(create);
    const name = within(groups).getByRole("textbox", { name: "新标签分组名称" });
    fireEvent.change(name, { target: { value: "发色" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|create_shared_tag_group")).toEqual([{ name: "发色", namespace: null }]),
    );
    const hair = await within(groups).findByRole("group", { name: "发色" });

    const addMember = await waitFor(() => {
      const button = within(hair).getByRole<HTMLButtonElement>("button", { name: "给“发色”加标签" });
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(addMember);
    fireEvent.change(within(hair).getByRole("combobox", { name: "挑一个统一标签" }), { target: { value: "蓝" } });
    fireEvent.click(await screen.findByRole("option", { name: /蓝发/ }));
    await waitFor(() =>
      expect(sent("plugin:library|edit_shared_tag_group")).toEqual([{ edit: { kind: "addMembers", groupId: "G1", tagIds: ["T-blue"] }, safeMode: true }]),
    );
    const blue = await within(groups).findByRole("button", { name: "蓝发（1 张）" });

    fireEvent.click(blue);
    await waitFor(() =>
      expect(sent("plugin:library|browse").at(-1)).toMatchObject({
        query: { conditions: { conditions: [{ any: [{ kind: "tag", tag: { id: "T-blue" } }], negate: false }] } },
      }),
    );
  });

  it("给图加上分组里的标签后，侧栏计数随词表刷新", async () => {
    fake.groups.push({ id: "G1", name: "发色", namespace: null, members: ["T-blue"] });
    render(<App />);
    const groups = await openGroups();
    expect(await within(groups).findByRole("button", { name: "蓝发（1 张）" })).toBeTruthy();
    await closeGroups();

    await screen.findAllByRole("img");
    fireEvent.keyDown(card("b"), { key: " " });
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: "蓝发" } });
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    expect(await within(await openGroups()).findByRole("button", { name: "蓝发（2 张）" })).toBeTruthy();
  });

  it("改名、移出成员与删除分组；命名空间分组列出该命名空间的全部标签", async () => {
    fake.groups.push({ id: "G1", name: "发色", namespace: null, members: ["T-blue", "T-smile"] });
    render(<App />);
    const groups = await openGroups();
    const hair = await within(groups).findByRole("group", { name: "发色" });
    await within(hair).findByRole("button", { name: "微笑（1 张）" });

    fireEvent.click(within(hair).getByRole("button", { name: "把“微笑”移出“发色”" }));
    await waitFor(() => expect(within(groups).queryByRole("button", { name: "微笑（1 张）" })).toBeNull());
    expect(sent("plugin:library|edit_shared_tag_group").at(-1)).toEqual({ edit: { kind: "removeMembers", groupId: "G1", tagIds: ["T-smile"] }, safeMode: true });

    const currentHair = await within(groups).findByRole("group", { name: "发色" });
    fireEvent.doubleClick(within(currentHair).getByRole("button", { name: /^发色/ }));
    const rename = within(groups).getByRole("textbox", { name: "标签分组名称" });
    fireEvent.change(rename, { target: { value: "头发颜色" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(await within(groups).findByRole("group", { name: "头发颜色" })).toBeTruthy();
    expect(sent("plugin:library|edit_shared_tag_group").at(-1)).toEqual({ edit: { kind: "rename", groupId: "G1", name: "头发颜色" }, safeMode: true });

    fireEvent.click(await waitFor(() => {
      const button = within(groups).getByRole<HTMLButtonElement>("button", { name: "新建标签分组" });
      expect(button.disabled).toBe(false);
      return button;
    }));
    await chooseValue(within(groups).getByRole("combobox", { name: "分组内容" }), "general");
    const name = within(groups).getByRole("textbox", { name: "新标签分组名称" });
    fireEvent.change(name, { target: { value: "一般" } });
    fireEvent.keyDown(name, { key: "Enter" });
    const general = await within(groups).findByRole("group", { name: "一般" });
    await within(general).findByRole("button", { name: "微笑（1 张）" });
    expect(within(general).queryByRole("button", { name: "给“一般”加标签" })).toBeNull();

    const deletes = sent("plugin:library|edit_shared_tag_group").length;
    fireEvent.click(within(groups).getByRole("button", { name: "删除标签分组“头发颜色”" }));
    // #98: deleting a group asks first; nothing is sent before the confirmation.
    const confirm = await screen.findByRole("alertdialog", { name: "删除分组" });
    expect(sent("plugin:library|edit_shared_tag_group").length).toBe(deletes);
    expect(within(groups).getByRole("group", { name: "头发颜色", hidden: true })).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(within(groups).queryByRole("group", { name: "头发颜色" })).toBeNull());
    expect(sent("plugin:library|edit_shared_tag_group").at(-1)).toEqual({ edit: { kind: "delete", groupId: "G1" }, safeMode: true });
  });

  it("安全模式切换后重新取得分组（被封印的图上的标签由资料库藏起）", async () => {
    render(<App />);
    await openGroups();
    await waitFor(() => expect(sent("plugin:library|shared_tag_groups").length).toBeGreaterThan(0));
    const before = sent("plugin:library|shared_tag_groups").length;
    await act(() => emit("library-event", { kind: "safeModeChanged", libraryId: "L1", on: false }));
    await waitFor(() => expect(sent("plugin:library|shared_tag_groups").length).toBeGreaterThan(before));
  });
});

describe("重新打开资料库", () => {
  it("标签决定与别名随资料库，全局分组随程序，重开后照样显示", async () => {
    fake.editTags(["a"], [{ kind: "reject", tag: { kind: "id", id: "T-smile" } }]);
    fake.tags.get("T-blue")!.aliases.push({ name: "蓝头发", lang: "zh-CN" });
    fake.groups.push({ id: "G1", name: "发色", namespace: null, members: ["T-blue"] });
    const first = render(<App />);
    await openGroups();
    first.unmount();

    render(<App />);
    const groups = await openGroups();
    expect(await within(groups).findByRole("button", { name: "蓝发（1 张）" })).toBeTruthy();
    await closeGroups();
    await selectOnly("a");
    const rejected = await screen.findByRole("list", { name: "已否决" });
    expect(rejected.textContent).toContain("微笑");
  });
});
