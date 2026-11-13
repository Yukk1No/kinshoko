// 标签整理（#77 UI-B，#51，#42 用户故事 58、59、64、65、81）：在主窗口里查看单图的有效标签与
// 出处，添加、否决、清除人工标签决定（含批量），给标签添加别名并按别名查到，建立与编辑标签分组并
// 在侧栏按分组浏览。后端是有状态的模拟资料库：写入后像核心一样推送 vocabularyChanged／
// imagesChanged，界面靠这些事件刷新词表、计数与候选（#76 的约定）。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import { fake, sent, card, tagList, openChip, selectOnly, addTag } from "./TagOrganize.fixtures";

describe("单张图的标签与人工标签决定", () => {
  it("列出有效标签及出处；排除模型标签后移到“已排除”，改回自动又回到模型建议", async () => {
    render(<App />);
    await selectOnly("a");
    const list = await screen.findByRole("list", { name: "有效标签" });
    await waitFor(() => expect(list.textContent).toContain("微笑"));
    expect(list.textContent).not.toContain("模型");
    const tip = await openChip("微笑");
    expect(tip.textContent).toContain("自动标签，可信度 92%（高）");

    fireEvent.click(within(tip).getByRole("button", { name: "排除“微笑”" }));
    await waitFor(() =>
      expect(sent("edit_tags")).toEqual([
        { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "reject", tag: { kind: "id", id: "T-smile" } }] },
      ]),
    );
    const rejected = await screen.findByRole("list", { name: "已排除" });
    await waitFor(() => expect(rejected.textContent).toContain("微笑"));
    expect(tagList().textContent).not.toContain("微笑");

    fireEvent.click(screen.getByRole("button", { name: "把“微笑”改回自动" }));
    await waitFor(() => expect(tagList().textContent).toContain("微笑"));
    expect(sent("edit_tags").at(-1)).toEqual({
      libraryId: "L1",
      imageIds: ["a"],
      edits: [{ kind: "clear", tag: { kind: "id", id: "T-smile" } }],
    });
    expect(screen.queryByRole("list", { name: "已排除" })).toBeNull();
  });

  it("按类别添加标签：同名不同类别是两个标签；人工添加的可以清除", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });

    await addTag("某某", { kind: "作者" });
    // 作者是一级标签（#518）：在属性表“作者”那一行，标签上不写前缀，也不在一般标签里。
    const artists = await screen.findByRole("list", { name: "作者" });
    await waitFor(() => expect(artists.textContent).toBe("某某"));
    expect(tagList().textContent).not.toContain("某某");
    // 已有“作者：某某”，第一行是它；同名的一般标签要选新建项（类别默认一般）。
    await addTag("某某", { create: true });
    await waitFor(() => expect(tagList().textContent).toContain("某某"));
    expect(sent("edit_tags")).toEqual([
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "named", namespace: "artist", name: "某某", lang: "zh-CN" } }] },
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "某某", lang: "zh-CN" } }] },
    ]);
    expect(document.querySelectorAll(".k-tag-chip.is-manual")).toHaveLength(2);
    expect((await openChip("某某")).textContent).toContain("来源：你添加的");

    // 浮层和读屏名仍写全名“作者：某某”。
    fireEvent.focus(within(artists).getByText("某某").closest("li")!);
    const tip = await screen.findByRole("dialog", { name: "“作者：某某”的出处" });
    fireEvent.click(within(tip).getByRole("button", { name: "把“作者：某某”改回自动" }));
    // 这一类没有标签了，这一行不再占位。
    await waitFor(() => expect(screen.queryByRole("list", { name: "作者" })).toBeNull());
  });

  it("模型建议的标签可以保留为人工添加，之后重新打标不会去掉它", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.click(within(await openChip("蓝发")).getByRole("button", { name: "保留“蓝发”" }));
    await waitFor(() =>
      expect(within(tagList()).getByText("蓝发").closest("li")!.className).toContain("is-manual"),
    );
    expect(sent("edit_tags")).toEqual([
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "id", id: "T-blue" } }] },
    ]);
  });
});

describe("批量标签决定", () => {
  it("选中多张图后一次添加或否决，所有选中的图都记下决定", async () => {
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("a"), { key: " " });
    fireEvent.click(card("b"), { ctrlKey: true });
    expect(await screen.findByText("已选 2 张")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "有效标签" })).toBeNull();

    await addTag("侧脸");
    await waitFor(() =>
      expect(sent("edit_tags")).toEqual([
        {
          libraryId: "L1",
          imageIds: ["a", "b"],
          edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "侧脸", lang: "zh-CN" } }],
        },
      ]),
    );
    expect(fake.effective("b").size).toBe(1);

    await addTag("微笑", { reject: true });
    await waitFor(() => expect(sent("edit_tags")).toHaveLength(2));
    expect(sent("edit_tags")[1]).toMatchObject({ imageIds: ["a", "b"], edits: [{ kind: "reject" }] });
    expect(fake.effective("a").has("T-smile")).toBe(false);
  });
});

describe("标签别名", () => {
  it("给标签添加别名后，搜索框按别名查到它；别名可以去掉", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.click(within(await openChip("蓝发")).getByRole("button", { name: "“蓝发”的别名" }));
    const dialog = await screen.findByRole("dialog", { name: "“蓝发”的别名" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "新别名" }), { target: { value: "蓝头发" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加别名" }));
    await waitFor(() =>
      expect(sent("add_tag_alias")).toEqual([
        { libraryId: "L1", tagId: "T-blue", alias: { name: "蓝头发", lang: "zh-CN" } },
      ]),
    );
    // 词表变化（vocabularyChanged）后别名列表从词表重新取得。
    await waitFor(() => expect(within(dialog).getByText("蓝头发")).toBeTruthy());

    const search = screen.getByRole("combobox", { name: "查找参考图" });
    fireEvent.change(search, { target: { value: "蓝头" } });
    const option = await screen.findByRole("option", { name: /蓝发/ });
    expect(option.textContent).toContain("别名 蓝头发");

    fireEvent.click(within(dialog).getByRole("button", { name: "去掉别名“蓝头发”" }));
    await waitFor(() => expect(within(dialog).queryByText("蓝头发")).toBeNull());
    expect(sent("remove_tag_alias")).toEqual([{ libraryId: "L1", tagId: "T-blue", alias: "蓝头发" }]);
  });

  it("添加标签时输入别名，落到原来的标签上", async () => {
    fake.tags.get("T-blue")!.aliases.push({ name: "蓝头发", lang: "zh-CN" });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("b"), { key: " " });
    await screen.findByRole("list", { name: "有效标签" });
    await addTag("蓝头发");
    await waitFor(() => expect(tagList().textContent).toContain("蓝发"));
    expect(fake.tags.size).toBe(2);
  });
});

/** 标签栏的“编辑分组”打开分组编辑器（#98）。 */
