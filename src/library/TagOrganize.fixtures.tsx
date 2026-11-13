import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import { beforeEach, expect } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
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
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import { appStartup } from "../App.fixtures";
import { fakeBackend, type Args, type FakeBackend } from "../test/backend";
import { wallPage } from "../test/workspacePage";

// 标签整理测试共用的后端模拟与操作步骤。

export const library: LibraryInfo = { id: "L1", name: "工作参考", root: "D:\\参考\\工作参考" };
export const page: BrowsePage = {
  cards: [
    { id: "a", width: 100, height: 200, thumbnail: "L1/a/256", adult: false },
    { id: "b", width: 300, height: 100, thumbnail: "L1/b/256", adult: false },
  ],
  nextCursor: null,
  total: 2,
};
export const detail = (id: string): ImageDetail => ({
  id,
  originalName: `${id}.png`,
  collectedAt: 0,
  sourceLinks: [],
  versions: { previous: null, newer: [] },
  taggingFailure: null,
  width: 100,
  height: 200,
  folders: [],
  note: { manual: null, sources: [] },
  deletedAt: null,
  rating: { imageId: id, suggested: null, manual: null, effective: null },
});

export type Tag = { namespace: TagNamespace; name: string; aliases: TagAlias[]; external: string[] };
export type Group = { id: string; name: string; namespace: TagNamespace | null; members: string[] };

/**
 * 模拟资料库的标签部分，规则照核心：命名空间是身份的一部分；有效标签 = 人工添加 ∪（来源事实 −
 * 人工否决）；按名称或别名指向标签，找不到时新建。
 */
export class FakeTags {
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
    for (const [id, t] of this.tags) if (t.namespace === namespace && t.aliases.some((a) => a.name === text)) return id;
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
      safeMode: false,
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
            : t.kind === "text"
              ? { kind: "text" as const, text: t.text, tags: [], similar: [], ratings: [] }
              : t.kind === "rating"
                ? { kind: "rating" as const, rating: { ratings: t.ratings, r18: false } }
                : { kind: "taggingUnfinished" as const },
        ),
      })),
    };
  }
}

export let fake: FakeTags;
let backend: FakeBackend;
export const sent = (command: string) => backend.calls(command).map((call) => call.args);

/** 写入提交后，核心推送的事件（只推送给界面，事件线程先清掉 Search 缓存）。 */
export function announce(images: string[]) {
  fake.revision += 1;
  const events: LibraryEvent[] = [];
  if (images.length) events.push({ kind: "imagesChanged", libraryId: "L1", imageIds: images });
  events.push({ kind: "vocabularyChanged", libraryId: "L1", revision: fake.revision });
  setTimeout(() => events.forEach((e) => void emit("library-event", e)), 0);
}

export function serve() {
  const sidebar = { all: 2, trash: 0, folders: [] };
  const registrations = [{ library, unavailable: null }];
  const status = { revision: "fixture-0", libraries: registrations };
  /** 按命令名回答；没有写到的命令被拒绝。 */
  const replies: Record<string, (a: Record<string, never>) => unknown> = {
    ...appStartup,
    app_info: () => ({ productName: "Kinshoko", version: "9.9.9" }),
    current_library: () => library,
    registered_libraries: () => [{ library, unavailable: null }],
    workspace_status: () => status,
    workspace_directories: () =>
      ({
        status,
        registrationOrder: [library.id],
        providers: [{ registration: registrations[0], unassigned: 0, descendants: {}, sidebar }],
      }) satisfies WorkspaceDirectories,
    workspace_browse: () => wallPage(page, library),
    safe_mode: () => true,
    workspace_sidebar: () => sidebar,
    image: (a) => detail(a.imageId),
    recovery: () => ({ interrupted: [], orphans: [], discardedStaging: 0 }),
    catalog_image_tags: (a) => ({ image: fake.imageTags(a.imageId), identities: [] }),
    edit_tags: (a) => {
      fake.editTags(a.imageIds, a.edits);
      announce(a.imageIds);
      return null;
    },
    vocabulary: () => fake.vocabulary(),
    workspace_tag_groups: () => fake.tagGroups(),
    shared_tag_groups: () => fake.tagGroups().map((group) => ({ ...group, sources: [] })),
    workspace_local_tags: (a) => a.ids,
    rating_candidates: () => [],
    search_candidates: (a) => fake.candidates(a.text),
    workspace_candidates: (a) => fake.candidates(a.text),
    workspace_library_candidates: (a) => fake.candidates(a.text),
    workspace_resolve: (a) => fake.resolveSearch(a.input),
    add_tag_alias: (a) => {
      fake.tags.get(a.tagId)!.aliases.push(a.alias as TagAlias);
      announce([]);
      return null;
    },
    remove_tag_alias: (a) => {
      const t = fake.tags.get(a.tagId)!;
      t.aliases = t.aliases.filter((x) => x.name !== a.alias);
      announce([]);
      return null;
    },
    create_shared_tag_group: (a) => {
      const id = `G${fake.groups.length + 1}`;
      fake.groups.push({ id, name: a.name, namespace: a.namespace, members: [] });
      announce([]);
      return id;
    },
    delete_shared_tag_group: (a) => {
      const ord = fake.groups.findIndex((g) => g.id === a.groupId);
      const [group] = fake.groups.splice(ord, 1);
      announce([]);
      return {
        id: group.id,
        name: group.name,
        namespace: group.namespace,
        ord,
        members: [...group.members],
        migratedFrom: [],
      };
    },
    restore_shared_tag_group: (a) => {
      const d = a.deleted as {
        id: string;
        name: string;
        namespace: TagNamespace | null;
        ord: number;
        members: string[];
      };
      fake.groups.splice(Math.min(d.ord, fake.groups.length), 0, {
        id: d.id,
        name: d.name,
        namespace: d.namespace,
        members: d.members,
      });
      announce([]);
      return null;
    },
    edit_shared_tag_group: (a) => {
      const edit = a.edit as CatalogGroupEdit;
      switch (edit.kind) {
        case "rename":
          fake.groups.find((g) => g.id === edit.groupId)!.name = edit.name;
          break;
        case "delete":
          fake.groups = fake.groups.filter((g) => g.id !== edit.groupId);
          break;
        case "addMembers": {
          const group = fake.groups.find((g) => g.id === edit.groupId)!;
          for (const id of edit.tagIds) if (!group.members.includes(id)) group.members.push(id);
          break;
        }
        case "removeMembers": {
          const group = fake.groups.find((g) => g.id === edit.groupId)!;
          group.members = group.members.filter((id) => !edit.tagIds.includes(id));
          break;
        }
        case "orderMembers":
          fake.groups.find((g) => g.id === edit.groupId)!.members = edit.tagIds;
          break;
        case "orderGroups":
          fake.groups.sort((a, b) => edit.groupIds.indexOf(a.id) - edit.groupIds.indexOf(b.id));
          break;
      }
      announce([]);
      return null;
    },
    tagging_status: () => ({ state: "starting" }),
    shell_settings: () => ({ autostart: true, shortcuts: [], showApproxSource: false, inspectorOpen: true }),
  };
  backend = fakeBackend(replies as Record<string, (args: Args) => unknown>);
}

export const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
export const tagList = () => screen.getByRole("list", { name: "有效标签" });
/** 聚焦标签打开它的浮层（#160）：出处、可信度和操作按钮都在里面。 */
export async function openChip(name: string) {
  const chip = await waitFor(() => within(tagList()).getByText(name).closest("li")!);
  fireEvent.focus(chip);
  return screen.findByRole("dialog", { name: `“${name}”的出处` });
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
  window.__KINSHOKO_TEST_PICKS__ = [];
  fake = new FakeTags();
  serve();
});

export async function selectOnly(id: string) {
  await screen.findAllByRole("img");
  fireEvent.keyDown(card(id), { key: " " });
}

/**
 * 在详情面板的“添加标签”里输入 `name` 并选一行：默认选第一行（匹配的标签，或没有匹配时的新建项）；
 * `create` 选新建项，`kind` 先在新建项上选类别；`reject` 用 Alt+回车排除。
 */
export async function addTag(
  name: string,
  { create, kind, reject }: { create?: boolean; kind?: string; reject?: boolean } = {},
) {
  const input = screen.getByRole("combobox", { name: "标签名" });
  input.focus();
  fireEvent.change(input, { target: { value: name } });
  const list = await screen.findByRole("listbox", { name: "标签名" });
  if (create || kind) {
    const row = await within(list).findByRole("option", { name: /^新建/ });
    if (kind) fireEvent.click(within(row).getByRole("radio", { name: kind }));
    await waitFor(() => expect(within(row).queryByRole("radio", { checked: true })?.textContent).toBe(kind ?? "一般"));
    fireEvent.click(row);
    return;
  }
  await within(list).findAllByRole("option");
  fireEvent.keyDown(input, { key: "Enter", altKey: !!reject });
}
