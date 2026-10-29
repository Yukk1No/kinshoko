// 标签整理（#77 UI-B，#51，#42 用户故事 58、59、64、65、81）：在主窗口里查看单图的有效标签与
// 出处，添加、否决、清除人工标签决定（含批量），给标签加别名并按别名查到，建立与编辑标签分组并
// 在侧栏按分组浏览。后端是有状态的模拟资料库：写入后像核心一样推送 vocabularyChanged／
// imagesChanged，界面靠这些事件刷新词表、计数与候选（#76 的约定）。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import { fake, sent, card, tagList, openChip, selectOnly } from "./TagOrganize.fixtures";
import { chooseValue } from "../test/select";

describe("单张图的标签与人工标签决定", () => {
  it("列出有效标签及出处；否决模型标签后移到“已否决”，撤销否决又回到模型建议", async () => {
    render(<App />);
    await selectOnly("a");
    const list = await screen.findByRole("list", { name: "有效标签" });
    await waitFor(() => expect(list.textContent).toContain("微笑"));
    expect(list.textContent).not.toContain("模型");
    const tip = await openChip("微笑");
    expect(tip.textContent).toContain("自动标签，可信度 92%（高）");

    fireEvent.click(within(tip).getByRole("button", { name: "否决“微笑”" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit_tags")).toEqual([
        { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "reject", tag: { kind: "id", id: "T-smile" } }] },
      ]),
    );
    const rejected = await screen.findByRole("list", { name: "已否决" });
    await waitFor(() => expect(rejected.textContent).toContain("微笑"));
    expect(tagList().textContent).not.toContain("微笑");

    fireEvent.click(screen.getByRole("button", { name: "撤销否决“微笑”" }));
    await waitFor(() => expect(tagList().textContent).toContain("微笑"));
    expect(sent("plugin:library|edit_tags").at(-1)).toEqual({
      libraryId: "L1",
      imageIds: ["a"],
      edits: [{ kind: "clear", tag: { kind: "id", id: "T-smile" } }],
    });
    expect(screen.queryByRole("list", { name: "已否决" })).toBeNull();
  });

  it("按命名空间添加标签：同名不同命名空间是两个标签；人工添加的可以清除", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });

    const add = async (namespace: string, name: string) => {
      await chooseValue(screen.getByRole("combobox", { name: "命名空间" }), namespace);
      fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    };
    await add("artist", "某某");
    await waitFor(() => expect(tagList().textContent).toContain("作者：某某"));
    await add("general", "某某");
    await waitFor(() => expect(within(tagList()).getAllByText(/某某/)).toHaveLength(2));
    expect(sent("plugin:library|edit_tags")).toEqual([
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "named", namespace: "artist", name: "某某", lang: "zh-CN" } }] },
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "某某", lang: "zh-CN" } }] },
    ]);
    expect(tagList().querySelectorAll(".k-tag-chip.is-manual")).toHaveLength(2);
    expect((await openChip("某某")).textContent).toContain("来源：你添加的");

    fireEvent.click(within(await openChip("作者：某某")).getByRole("button", { name: "清除对“作者：某某”的人工决定" }));
    await waitFor(() => expect(tagList().textContent).not.toContain("作者：某某"));
  });

  it("模型建议的标签可以确认为人工添加，之后重新打标不会去掉它", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.click(within(await openChip("蓝发")).getByRole("button", { name: "确认“蓝发”" }));
    await waitFor(() =>
      expect(within(tagList()).getByText("蓝发").closest("li")!.className).toContain("is-manual"),
    );
    expect(sent("plugin:library|edit_tags")).toEqual([
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

    fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: "侧脸" } });
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    await waitFor(() =>
      expect(sent("plugin:library|edit_tags")).toEqual([
        {
          libraryId: "L1",
          imageIds: ["a", "b"],
          edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "侧脸", lang: "zh-CN" } }],
        },
      ]),
    );
    expect(fake.effective("b").size).toBe(1);

    fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: "微笑" } });
    fireEvent.click(screen.getByRole("button", { name: "否决标签" }));
    await waitFor(() => expect(sent("plugin:library|edit_tags")).toHaveLength(2));
    expect(sent("plugin:library|edit_tags")[1]).toMatchObject({ imageIds: ["a", "b"], edits: [{ kind: "reject" }] });
    expect(fake.effective("a").has("T-smile")).toBe(false);
  });
});

describe("标签别名", () => {
  it("给标签加别名后，搜索框按别名查到它；别名可以去掉", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.click(within(await openChip("蓝发")).getByRole("button", { name: "“蓝发”的别名" }));
    const dialog = await screen.findByRole("dialog", { name: "“蓝发”的别名" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "新别名" }), { target: { value: "蓝头发" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "加别名" }));
    await waitFor(() =>
      expect(sent("plugin:library|add_tag_alias")).toEqual([
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
    expect(sent("plugin:library|remove_tag_alias")).toEqual([{ libraryId: "L1", tagId: "T-blue", alias: "蓝头发" }]);
  });

  it("添加标签时输入别名，落到原来的标签上", async () => {
    fake.tags.get("T-blue")!.aliases.push({ name: "蓝头发", lang: "zh-CN" });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.keyDown(card("b"), { key: " " });
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: "蓝头发" } });
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    await waitFor(() => expect(tagList().textContent).toContain("蓝发"));
    expect(fake.tags.size).toBe(2);
  });
});

/** 标签栏的“编辑分组”打开分组编辑器（#98）。 */
