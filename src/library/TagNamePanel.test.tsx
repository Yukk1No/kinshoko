import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { TagNamePanel } from "./TagNamePanel";

afterEach(() => { cleanup(); clearMocks(); });
const tag = () => ({ id: "shared", namespace: "general", names: [{ lang: "zh-CN", name: "分缝发型" }, { lang: "en", name: "Parted hair" }], defaultNames: [{ lang: "zh-CN", name: "分缝发型" }, { lang: "en", name: "Parted hair" }], namePreferences: [] as { lang: string; name: string }[], aliases: [{ name: "分发", lang: "zh-CN" }], external: [{ vocabulary: "danbooru", name: "parted_hair" }] });
const workspace = () => ({ libraries: [], catalog: { revision: 1, tags: [tag()], mappings: [] } });

it("loads the catalog and saves an equal-default preference explicitly, keeps aliases separate and resets the preference", async () => {
  let data = workspace();
  const edits: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("inspect_tag_catalog")) return data;
    if (cmd.endsWith("edit_tag_name")) {
      edits.push(args);
      const edit = (args as { edit: { kind: string; name?: { lang: string; name: string } } }).edit;
      data = { ...data, catalog: { ...data.catalog, revision: data.catalog.revision + 1, tags: [{ ...data.catalog.tags[0], namePreferences: edit.kind === "prefer" && edit.name ? [edit.name] : [] }] } };
      return data;
    }
  });
  render(<TagNamePanel />);
  const row = await screen.findByRole("listitem", { name: "分缝发型 · 默认" });
  expect(within(row).getByText(/别名 分发/)).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "改名“分缝发型”" }));
  expect(within(row).getByRole("listitem").textContent).toBe("分发");
  fireEvent.click(within(row).getByRole("button", { name: "记为我的叫法" }));
  await within(row).findByText("我的叫法");
  expect(edits[0]).toEqual({ catalogId: "shared", edit: { kind: "prefer", name: { lang: "zh-CN", name: "分缝发型" } } });
  fireEvent.click(within(row).getByRole("button", { name: "恢复默认" }));
  await within(row).findByText("默认");
  expect(edits[1]).toEqual({ catalogId: "shared", edit: { kind: "reset", lang: "zh-CN" } });
  fireEvent.change(screen.getByRole("textbox", { name: "名称语言" }), { target: { value: "en" } });
  // 编辑中的标签换语言后仍然展开，显示该语言的名称。
  expect(screen.getByRole("textbox", { name: "“Parted hair”的我的叫法" }).getAttribute("value")).toBe("Parted hair");
});

it("discards a late name edit result when safe mode changes", async () => {
  const data = workspace();
  let finish: (value: ReturnType<typeof workspace>) => void = () => {};
  const pending = new Promise<ReturnType<typeof workspace>>((resolve) => { finish = resolve; });
  mockIPC((cmd) => cmd.endsWith("edit_tag_name") ? pending : cmd.endsWith("inspect_tag_catalog") ? data : undefined, { shouldMockEvents: true });
  render(<TagNamePanel />);
  fireEvent.click(await screen.findByRole("button", { name: "改名“分缝发型”" }));
  fireEvent.click(screen.getByRole("button", { name: "记为我的叫法" }));
  await act(async () => { await emit("safe-mode-setting", true); finish(data); await pending; });
  expect(screen.queryByRole("button", { name: "记为我的叫法" })).toBeNull();
  expect(screen.queryByRole("listitem", { name: /分缝发型/ })).toBeNull();
});

it("edits one selected tag at a time and finds it by a separate alias in a large catalog", async () => {
  const data = workspace();
  data.catalog.tags = Array.from({ length: 150 }, (_, index) => ({ ...tag(), id: `shared-${index}`, names: [{ lang: "zh-CN", name: `发型 ${index}` }], aliases: [{ lang: "zh-CN", name: index === 149 ? "目标别名" : `叫法 ${index}` }] }));
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  const list = await screen.findByRole("list", { name: "标签" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(80);
  expect(screen.getByText(/共 150 个，先列出 80 个/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "改名“发型 0”" }));
  fireEvent.click(screen.getByRole("button", { name: "改名“发型 1”" }));
  expect(screen.getAllByRole("button", { name: "记为我的叫法" })).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "查找要改名称的标签" }), { target: { value: "目标别名" } });
  fireEvent.click(screen.getByRole("button", { name: "改名“发型 149”" }));
  expect(screen.getByRole("textbox", { name: /我的叫法/ }).getAttribute("value")).toBe("发型 149");
});

it("can select an untranslated tag and find it by its external name", async () => {
  const data = workspace();
  data.catalog.tags = [{ ...tag(), names: [], defaultNames: [], aliases: [], external: [{ vocabulary: "danbooru", name: "untranslated_hair" }] }];
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  fireEvent.change(screen.getByRole("textbox", { name: "查找要改名称的标签" }), { target: { value: "untranslated_hair" } });
  fireEvent.click(await screen.findByRole("button", { name: "改名“untranslated hair”" }));
  expect(screen.getByRole("textbox", { name: /我的叫法/ }).getAttribute("value")).toBe("untranslated hair");
});

it("marks a tag whose old library name is still pending", async () => {
  const data = { ...workspace(), catalog: { ...workspace().catalog, mappings: [{ libraryId: "a", localTagId: "x", catalogId: "shared", legacy: { id: "x", namespace: "general", names: [], aliases: [], external: [] }, nameProvenance: "pending", basis: "external" }] } };
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  expect(await screen.findByRole("listitem", { name: "分缝发型 · 待确认" })).toBeTruthy();
});
