// 标签整理（#77 UI-B，#51，#42 用户故事 58、59、64、65、81）：在主窗口里查看单图的有效标签与
// 出处，添加、否决、清除人工标签决定（含批量），给标签加别名并按别名查到，建立与编辑标签分组并
// 在侧栏按分组浏览。后端是有状态的模拟资料库：写入后像核心一样推送 vocabularyChanged／
// imagesChanged，界面靠这些事件刷新词表、计数与候选（#76 的约定）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { BrowsePage } from "../bindings/BrowsePage";
import type { Candidate } from "../bindings/Candidate";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { ImageTags } from "../bindings/ImageTags";
import type { LibraryEvent } from "../bindings/LibraryEvent";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { SearchInput } from "../bindings/SearchInput";
import type { TagAlias } from "../bindings/TagAlias";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagGroupView } from "../bindings/TagGroupView";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { TagRef } from "../bindings/TagRef";
import type { Vocabulary } from "../bindings/Vocabulary";
import { App } from "../App";

const library: LibraryInfo = { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" };
const page: BrowsePage = {
  cards: [
    { id: "a", width: 100, height: 200, thumbnail: "L1/a/256", adult: false },
    { id: "b", width: 300, height: 100, thumbnail: "L1/b/256", adult: false },
  ],
  nextCursor: null,
  total: 2,
};
const detail = (id: string): ImageDetail => ({
  id,
  originalName: `${id}.png`,
  collectedAt: 0,
  sourceLinks: [],
  versions: { previous: null, newer: [] },
  width: 100,
  height: 200,
  folders: [],
  note: { manual: null, sources: [] },
  deletedAt: null,
  rating: { imageId: id, suggested: null, manual: null, effective: null },
});

type Tag = { namespace: TagNamespace; name: string; aliases: TagAlias[]; external: string[] };
type Group = { id: string; name: string; namespace: TagNamespace | null; members: string[] };

/**
 * 模拟资料库的标签部分，规则照核心：命名空间是身份的一部分；有效标签 = 人工添加 ∪（来源事实 −
 * 人工否决）；按名称或别名指向标签，找不到时新建。
 */
class FakeTags {
  tags = new Map<string, Tag>();
  /** 来源事实：图 → [标签, 来源, 分数]。 */
  facts = new Map<string, [string, string, number | null][]>();
  decisions = new Map<string, Map<string, "add" | "reject">>();
  groups: Group[] = [];
  revision = 1;
  private next = 0;

  constructor() {
    this.tags.set("T-smile", { namespace: "general", name: "微笑", aliases: [], external: ["smile"] });
    this.tags.set("T-blue", { namespace: "general", name: "蓝发", aliases: [], external: ["blue_hair"] });
    this.facts.set("a", [
      ["T-smile", "model:pixai", 0.92],
      ["T-blue", "model:pixai", 0.81],
    ]);
  }

  label(id: string): TagLabel {
    const t = this.tags.get(id)!;
    return { id, namespace: t.namespace, name: t.name, untranslated: false, hasExternal: t.external.length > 0 };
  }

  effective(image: string): Set<string> {
    const decided = this.decisions.get(image) ?? new Map();
    const out = new Set((this.facts.get(image) ?? []).map(([t]) => t));
    for (const [t, d] of decided) {
      if (d === "add") out.add(t);
      else out.delete(t);
    }
    return out;
  }

  count(tag: string) {
    return page.cards.filter((c) => this.effective(c.id).has(tag)).length;
  }

  find(namespace: TagNamespace, name: string): string | undefined {
    const text = name.trim();
    for (const [id, t] of this.tags) if (t.namespace === namespace && t.name === text) return id;
    for (const [id, t] of this.tags)
      if (t.namespace === namespace && t.aliases.some((a) => a.name === text)) return id;
    return undefined;
  }

  resolve(ref: TagRef, create: boolean): string | undefined {
    if (ref.kind === "id") return ref.id;
    if (ref.kind === "external") throw new Error("界面不按外部名称指向标签");
    const found = this.find(ref.namespace, ref.name);
    if (found || !create) return found;
    const id = `T${++this.next}`;
    this.tags.set(id, { namespace: ref.namespace, name: ref.name.trim(), aliases: [], external: [] });
    return id;
  }

  imageTags(image: string): ImageTags {
    const decided = this.decisions.get(image) ?? new Map();
    const tags = [...this.effective(image)].map((id) => ({
      tag: this.label(id),
      origins: [
        ...(this.facts.get(image) ?? [])
          .filter(([t]) => t === id)
          .map(([, source, score]) => ({ kind: "source" as const, source, score })),
        ...(decided.get(id) === "add" ? [{ kind: "manual" as const }] : []),
      ],
    }));
    const rejected = [...decided].filter(([, d]) => d === "reject").map(([t]) => this.label(t));
    return { imageId: image, tags, rejected };
  }

  editTags(images: string[], edits: TagEdit[]) {
    for (const edit of edits) {
      const id = this.resolve(edit.tag, edit.kind !== "clear");
      if (!id) continue;
      for (const image of images) {
        const decided = this.decisions.get(image) ?? new Map();
        if (edit.kind === "clear") decided.delete(id);
        else decided.set(id, edit.kind === "add" ? "add" : "reject");
        this.decisions.set(image, decided);
      }
    }
  }

  candidates(text: string): Candidate[] {
    const q = text.trim();
    if (!q) return [];
    const out: Candidate[] = [];
    for (const [id, t] of this.tags) {
      const count = this.count(id);
      if (count === 0) continue;
      if (t.name.includes(q)) out.push({ tag: this.label(id), via: null, count });
      else {
        const alias = t.aliases.find((a) => a.name.includes(q));
        if (alias) out.push({ tag: this.label(id), via: alias.name, count });
      }
    }
    return out;
  }

  vocabulary(): Vocabulary {
    return {
      revision: this.revision,
      tags: [...this.tags].map(([id, t]) => ({
        id,
        namespace: t.namespace,
        names: [{ lang: "zh-CN", name: t.name }],
        aliases: t.aliases,
        external: t.external,
        count: this.count(id),
      })),
      personalApprox: [],
    };
  }

  tagGroups(): TagGroupView[] {
    return this.groups.map((g) => ({
      id: g.id,
      name: g.name,
      namespace: g.namespace,
      tags: (g.namespace
        ? [...this.tags].filter(([, t]) => t.namespace === g.namespace).map(([id]) => id)
        : g.members
      ).map((id) => ({ tag: this.label(id), count: this.count(id) })),
    }));
  }

  resolveSearch(input: SearchInput): ConditionTree {
    return {
      conditions: input.conditions.map((c) => ({
        negate: c.negate,
        any: c.any.map((t) =>
          t.kind === "tag"
            ? { kind: "tag" as const, tag: this.label(t.id), similar: [] }
            : { kind: "text" as const, text: t.text, tags: [], similar: [] },
        ),
      })),
    };
  }
}

let fake: FakeTags;
let calls: { cmd: string; args: unknown }[];
const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

/** 写入提交后，核心推送的事件（只推送给界面，事件线程先清掉 Search 缓存）。 */
function announce(images: string[]) {
  fake.revision += 1;
  const events: LibraryEvent[] = [];
  if (images.length) events.push({ kind: "imagesChanged", libraryId: "L1", imageIds: images });
  events.push({ kind: "vocabularyChanged", libraryId: "L1", revision: fake.revision });
  setTimeout(() => events.forEach((e) => void emit("library-event", e)), 0);
}

function backend() {
  calls = [];
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const a = args as Record<string, never>;
      switch (cmd) {
        case "app_info":
          return { productName: "Kinshoko", version: "9.9.9" };
        case "plugin:library|current_library":
          return library;
        case "plugin:library|registered_libraries":
          return [{ library, unavailable: null }];
        case "plugin:library|browse":
          return page;
        case "plugin:library|safe_mode":
          return true;
        case "plugin:library|sidebar":
          return { all: 2, trash: 0, folders: [] };
        case "plugin:library|image":
          return detail(a.imageId);
        case "plugin:library|recovery":
          return { interrupted: [], orphans: [], discardedStaging: 0 };
        case "plugin:library|image_tags":
          return fake.imageTags(a.imageId);
        case "plugin:library|edit_tags":
          fake.editTags(a.imageIds, a.edits);
          announce(a.imageIds);
          return null;
        case "plugin:library|vocabulary":
          return fake.vocabulary();
        case "plugin:library|tag_groups":
          return fake.tagGroups();
        case "plugin:library|search_candidates":
          return fake.candidates(a.text);
        case "plugin:library|resolve_search":
          return fake.resolveSearch(a.input);
        case "plugin:library|add_tag_alias": {
          fake.tags.get(a.tagId)!.aliases.push(a.alias as TagAlias);
          announce([]);
          return null;
        }
        case "plugin:library|remove_tag_alias": {
          const t = fake.tags.get(a.tagId)!;
          t.aliases = t.aliases.filter((x) => x.name !== a.alias);
          announce([]);
          return null;
        }
        case "plugin:library|create_tag_group": {
          const id = `G${fake.groups.length + 1}`;
          fake.groups.push({ id, name: a.name, namespace: a.namespace, members: [] });
          announce([]);
          return id;
        }
        case "plugin:library|rename_tag_group":
          fake.groups.find((g) => g.id === a.groupId)!.name = a.name;
          announce([]);
          return null;
        case "plugin:library|delete_tag_group":
          fake.groups = fake.groups.filter((g) => g.id !== a.groupId);
          announce([]);
          return null;
        case "plugin:library|add_to_tag_group": {
          const g = fake.groups.find((x) => x.id === a.groupId)!;
          for (const t of a.tagIds as string[]) if (!g.members.includes(t)) g.members.push(t);
          announce([]);
          return null;
        }
        case "plugin:library|remove_from_tag_group": {
          const g = fake.groups.find((x) => x.id === a.groupId)!;
          g.members = g.members.filter((t) => !(a.tagIds as string[]).includes(t));
          announce([]);
          return null;
        }
        case "tagging_status":
          return { libraryId: "L1", status: { state: "starting" } };
        case "shell_settings":
          return { autostart: true, shortcuts: [], showApproxSource: false };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
const tagList = () => screen.getByRole("list", { name: "有效标签" });

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  window.__KINSHOKO_TEST_PICKS__ = [];
  fake = new FakeTags();
  backend();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

async function selectOnly(id: string) {
  await screen.findAllByRole("img");
  fireEvent.click(card(id));
}

describe("单张图的标签与人工标签决定", () => {
  it("列出有效标签及出处；否决模型标签后移到“已否决”，撤销否决又回到模型建议", async () => {
    render(<App />);
    await selectOnly("a");
    const list = await screen.findByRole("list", { name: "有效标签" });
    await waitFor(() => expect(list.textContent).toContain("微笑"));
    expect(within(list).getByText("模型 0.92")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "否决“微笑”" }));
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

    const add = (namespace: string, name: string) => {
      fireEvent.change(screen.getByRole("combobox", { name: "命名空间" }), { target: { value: namespace } });
      fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    };
    add("artist", "某某");
    await waitFor(() => expect(tagList().textContent).toContain("作者：某某"));
    add("general", "某某");
    await waitFor(() => expect(within(tagList()).getAllByText(/某某/)).toHaveLength(2));
    expect(sent("plugin:library|edit_tags")).toEqual([
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "named", namespace: "artist", name: "某某", lang: "zh-CN" } }] },
      { libraryId: "L1", imageIds: ["a"], edits: [{ kind: "add", tag: { kind: "named", namespace: "general", name: "某某", lang: "zh-CN" } }] },
    ]);
    expect(within(tagList()).getAllByText("人工添加")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "清除对“作者：某某”的人工决定" }));
    await waitFor(() => expect(tagList().textContent).not.toContain("作者：某某"));
  });

  it("模型建议的标签可以确认为人工添加，之后重新打标不会去掉它", async () => {
    render(<App />);
    await selectOnly("a");
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.click(await screen.findByRole("button", { name: "确认“蓝发”" }));
    await waitFor(() =>
      expect(within(tagList()).getByText("蓝发").closest("li")!.textContent).toContain("人工添加"),
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
    fireEvent.click(card("a"));
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
    fireEvent.click(await screen.findByRole("button", { name: "“蓝发”的别名" }));
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
    expect(option.textContent).toContain("又名：蓝头发");

    fireEvent.click(within(dialog).getByRole("button", { name: "去掉别名“蓝头发”" }));
    await waitFor(() => expect(within(dialog).queryByText("蓝头发")).toBeNull());
    expect(sent("plugin:library|remove_tag_alias")).toEqual([{ libraryId: "L1", tagId: "T-blue", alias: "蓝头发" }]);
  });

  it("添加标签时输入别名，落到原来的标签上", async () => {
    fake.tags.get("T-blue")!.aliases.push({ name: "蓝头发", lang: "zh-CN" });
    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(card("b"));
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: "蓝头发" } });
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    await waitFor(() => expect(tagList().textContent).toContain("蓝发"));
    expect(fake.tags.size).toBe(2);
  });
});

describe("标签分组", () => {
  it("建立分组、从库内标签挑成员，侧栏按分组列出计数；点标签按它浏览", async () => {
    render(<App />);
    const groups = await screen.findByRole("region", { name: "标签分组" });
    fireEvent.click(within(groups).getByRole("button", { name: "新建标签分组" }));
    const name = within(groups).getByRole("textbox", { name: "新标签分组名称" });
    fireEvent.change(name, { target: { value: "发色" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() =>
      expect(sent("plugin:library|create_tag_group")).toEqual([{ libraryId: "L1", name: "发色", namespace: null }]),
    );
    const hair = await within(groups).findByRole("group", { name: "发色" });

    fireEvent.click(within(hair).getByRole("button", { name: "给“发色”加标签" }));
    fireEvent.change(within(hair).getByRole("combobox", { name: "挑一个库内标签" }), { target: { value: "蓝" } });
    fireEvent.click(await within(hair).findByRole("option", { name: /蓝发/ }));
    await waitFor(() =>
      expect(sent("plugin:library|add_to_tag_group")).toEqual([{ libraryId: "L1", groupId: "G1", tagIds: ["T-blue"] }]),
    );
    const blue = await within(hair).findByRole("button", { name: "蓝发（1 张）" });

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
    const groups = await screen.findByRole("region", { name: "标签分组" });
    expect(await within(groups).findByRole("button", { name: "蓝发（1 张）" })).toBeTruthy();

    await screen.findAllByRole("img");
    fireEvent.click(card("b"));
    await screen.findByRole("list", { name: "有效标签" });
    fireEvent.change(screen.getByRole("combobox", { name: "标签名" }), { target: { value: "蓝发" } });
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    expect(await within(groups).findByRole("button", { name: "蓝发（2 张）" })).toBeTruthy();
  });

  it("改名、移出成员与删除分组；命名空间分组列出该命名空间的全部标签", async () => {
    fake.groups.push({ id: "G1", name: "发色", namespace: null, members: ["T-blue", "T-smile"] });
    render(<App />);
    const groups = await screen.findByRole("region", { name: "标签分组" });
    const hair = await within(groups).findByRole("group", { name: "发色" });
    await within(hair).findByRole("button", { name: "微笑（1 张）" });

    fireEvent.click(within(hair).getByRole("button", { name: "把“微笑”移出“发色”" }));
    await waitFor(() => expect(within(hair).queryByRole("button", { name: "微笑（1 张）" })).toBeNull());
    expect(sent("plugin:library|remove_from_tag_group")).toEqual([{ libraryId: "L1", groupId: "G1", tagIds: ["T-smile"] }]);

    fireEvent.doubleClick(within(hair).getByRole("button", { name: /^发色/ }));
    const rename = within(groups).getByRole("textbox", { name: "标签分组名称" });
    fireEvent.change(rename, { target: { value: "头发颜色" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(await within(groups).findByRole("group", { name: "头发颜色" })).toBeTruthy();
    expect(sent("plugin:library|rename_tag_group")).toEqual([{ libraryId: "L1", groupId: "G1", name: "头发颜色" }]);

    fireEvent.click(within(groups).getByRole("button", { name: "新建标签分组" }));
    fireEvent.change(within(groups).getByRole("combobox", { name: "分组内容" }), { target: { value: "general" } });
    const name = within(groups).getByRole("textbox", { name: "新标签分组名称" });
    fireEvent.change(name, { target: { value: "一般" } });
    fireEvent.keyDown(name, { key: "Enter" });
    const general = await within(groups).findByRole("group", { name: "一般" });
    await within(general).findByRole("button", { name: "微笑（1 张）" });
    expect(within(general).queryByRole("button", { name: "给“一般”加标签" })).toBeNull();

    fireEvent.click(within(groups).getByRole("button", { name: "删除标签分组“头发颜色”" }));
    await waitFor(() => expect(within(groups).queryByRole("group", { name: "头发颜色" })).toBeNull());
    expect(sent("plugin:library|delete_tag_group")).toEqual([{ libraryId: "L1", groupId: "G1" }]);
  });

  it("安全模式切换后重新取得分组（被封印的图上的标签由资料库藏起）", async () => {
    render(<App />);
    await screen.findByRole("region", { name: "标签分组" });
    await waitFor(() => expect(sent("plugin:library|tag_groups").length).toBeGreaterThan(0));
    const before = sent("plugin:library|tag_groups").length;
    await act(() => emit("library-event", { kind: "safeModeChanged", libraryId: "L1", on: false }));
    await waitFor(() => expect(sent("plugin:library|tag_groups").length).toBeGreaterThan(before));
  });
});

describe("重新打开资料库", () => {
  it("标签决定、别名与分组由资料库保存，重开后照样显示", async () => {
    fake.editTags(["a"], [{ kind: "reject", tag: { kind: "id", id: "T-smile" } }]);
    fake.tags.get("T-blue")!.aliases.push({ name: "蓝头发", lang: "zh-CN" });
    fake.groups.push({ id: "G1", name: "发色", namespace: null, members: ["T-blue"] });
    const first = render(<App />);
    await screen.findByRole("region", { name: "标签分组" });
    first.unmount();

    render(<App />);
    const groups = await screen.findByRole("region", { name: "标签分组" });
    expect(await within(groups).findByRole("button", { name: "蓝发（1 张）" })).toBeTruthy();
    await selectOnly("a");
    const rejected = await screen.findByRole("list", { name: "已否决" });
    expect(rejected.textContent).toContain("微笑");
  });
});
