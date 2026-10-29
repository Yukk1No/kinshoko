import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { TagNamePanel } from "./TagNamePanel";
import { chooseValue } from "../test/select";

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
  const row = await screen.findByRole("listitem", { name: "分缝发型，默认" });
  expect(row.getAttribute("title")).toMatch(/别名 分发/);
  fireEvent.click(within(row).getByRole("button", { name: "改名“分缝发型”" }));
  expect(within(row).getByRole("listitem").textContent).toBe("分发");
  fireEvent.click(within(row).getByRole("button", { name: "保存显示名" }));
  await within(row).findByText("已改名");
  expect(edits[0]).toEqual({ catalogId: "shared", edit: { kind: "prefer", name: { lang: "zh-CN", name: "分缝发型" } } });
  fireEvent.click(within(row).getByRole("button", { name: "恢复默认" }));
  await within(row).findByText("默认");
  expect(edits[1]).toEqual({ catalogId: "shared", edit: { kind: "reset", lang: "zh-CN" } });
  fireEvent.change(screen.getByRole("textbox", { name: "名称语言" }), { target: { value: "en" } });
  // 编辑中的标签换语言后仍然展开，显示该语言的名称。
  expect(screen.getByRole("textbox", { name: "“Parted hair”的显示名" }).getAttribute("value")).toBe("Parted hair");
});

it("discards a late name edit result when safe mode changes", async () => {
  const data = workspace();
  let finish: (value: ReturnType<typeof workspace>) => void = () => {};
  const pending = new Promise<ReturnType<typeof workspace>>((resolve) => { finish = resolve; });
  mockIPC((cmd) => cmd.endsWith("edit_tag_name") ? pending : cmd.endsWith("inspect_tag_catalog") ? data : undefined, { shouldMockEvents: true });
  render(<TagNamePanel />);
  fireEvent.click(await screen.findByRole("button", { name: "改名“分缝发型”" }));
  fireEvent.click(screen.getByRole("button", { name: "保存显示名" }));
  await act(async () => { await emit("safe-mode-setting", true); finish(data); await pending; });
  expect(screen.queryByRole("button", { name: "保存显示名" })).toBeNull();
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
  expect(screen.getAllByRole("button", { name: "保存显示名" })).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "查找要改名称的标签" }), { target: { value: "目标别名" } });
  fireEvent.click(screen.getByRole("button", { name: "改名“发型 149”" }));
  expect(screen.getByRole("textbox", { name: /的显示名/ }).getAttribute("value")).toBe("发型 149");
});

it("can select an untranslated tag and find it by its external name", async () => {
  const data = workspace();
  data.catalog.tags = [{ ...tag(), names: [], defaultNames: [], aliases: [], external: [{ vocabulary: "danbooru", name: "untranslated_hair" }] }];
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  fireEvent.change(screen.getByRole("textbox", { name: "查找要改名称的标签" }), { target: { value: "untranslated_hair" } });
  fireEvent.click(await screen.findByRole("button", { name: "改名“untranslated hair”" }));
  expect(screen.getByRole("textbox", { name: /的显示名/ }).getAttribute("value")).toBe("untranslated hair");
});

it("marks a tag whose old library name is still pending", async () => {
  const data = { ...workspace(), catalog: { ...workspace().catalog, mappings: [{ libraryId: "a", localTagId: "x", catalogId: "shared", legacy: { id: "x", namespace: "general", names: [], aliases: [], external: [] }, nameProvenance: "pending", basis: "external" }] } };
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  expect(await screen.findByRole("listitem", { name: "分缝发型，待确认" })).toBeTruthy();
});

it("uses one set of words: renamed/default status and an only-renamed filter", async () => {
  const data = workspace();
  data.catalog.tags = [{ ...tag(), namePreferences: [{ lang: "zh-CN", name: "分缝发型" }] }, { ...tag(), id: "other", names: [{ lang: "zh-CN", name: "长发" }] }];
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  expect(await screen.findByRole("listitem", { name: "分缝发型，已改名" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "只看改过名的" }));
  expect(screen.queryByRole("listitem", { name: "长发，默认" })).toBeNull();
});

it("opens with the requested tag first and expanded, even past the listing limit (#182)", async () => {
  const data = workspace();
  data.catalog.tags = Array.from({ length: 120 }, (_, index) => ({ ...tag(), id: `shared-${index}`, names: [{ lang: "zh-CN", name: `发型 ${index}` }], aliases: [] }));
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel focus="shared-110" />);
  const row = await screen.findByRole("listitem", { name: "发型 110，默认" });
  expect(within(screen.getByRole("list", { name: "标签" })).getAllByRole("listitem")[0]).toBe(row);
  expect(within(row).getByRole("button", { name: "改名“发型 110”" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(row).getByRole("textbox", { name: "“发型 110”的显示名" })).toBeTruthy();
});

it("lists tags without an external mapping, corrects a source name's language and maps one like the import wizard (#217)", async () => {
  const eagle = { ...tag(), id: "eagle", names: [{ lang: "en", name: "hatsune miku" }], defaultNames: [], aliases: [], external: [], sourceNames: [{ lang: "en", name: "hatsune miku" }] };
  const mapping = { libraryId: "L1", localTagId: "local-eagle", catalogId: "eagle", nameProvenance: "catalog", basis: "independent", sourceNames: [{ lang: "en", name: "hatsune miku" }],
    legacy: { id: "local-eagle", namespace: "general", names: [], aliases: [], external: [], count: 1, sourceNames: [] } };
  const data = { libraries: [{ library: { id: "L1", name: "参考" }, unavailable: null }], catalog: { revision: 1, tags: [{ ...tag(), sourceNames: [] }, eagle], mappings: [mapping] } };
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd.endsWith("inspect_tag_catalog")) return data;
    if (cmd.endsWith("map_tag_external")) return { external: "hatsune_miku", known: true, mergedInto: null };
    if (cmd.endsWith("external_suggestions")) return ["hatsune_miku"];
  });
  render(<TagNamePanel />);
  await screen.findByRole("listitem", { name: /分缝发型/ });
  fireEvent.click(screen.getByRole("checkbox", { name: "只看没有外部对应的" }));
  expect(screen.queryByRole("listitem", { name: /分缝发型/ })).toBeNull();
  const row = screen.getByRole("listitem", { name: /hatsune miku/ });
  fireEvent.click(within(row).getByRole("button", { name: "改名“hatsune miku”" }));

  await chooseValue(within(row).getByRole("combobox", { name: "“hatsune miku”的语言" }), "ja");
  await waitFor(() => expect(calls).toContainEqual({ cmd: "plugin:library|set_source_name_lang", args: { libraryId: "L1", tagId: "local-eagle", name: "hatsune miku", lang: "ja" } }));

  fireEvent.change(within(row).getByRole("combobox", { name: "“hatsune miku”的外部对应" }), { target: { value: "hatsune_miku" } });
  fireEvent.click(within(row).getByRole("button", { name: "补上外部对应" }));
  await waitFor(() => expect(calls).toContainEqual({ cmd: "plugin:library|map_tag_external", args: { libraryId: "L1", tagId: "local-eagle", external: "hatsune_miku" } }));
});
