import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { TagNamePanel } from "./TagNamePanel";

afterEach(() => { cleanup(); clearMocks(); });
const tag = () => ({ id: "shared", namespace: "general", names: [{ lang: "zh-CN", name: "分缝发型" }, { lang: "en", name: "Parted hair" }], defaultNames: [{ lang: "zh-CN", name: "分缝发型" }, { lang: "en", name: "Parted hair" }], namePreferences: [] as { lang: string; name: string }[], aliases: [{ name: "分发", lang: "zh-CN" }], external: [{ vocabulary: "danbooru", name: "parted_hair" }] });
const workspace = () => ({ libraries: [], catalog: { revision: 1, tags: [tag()], mappings: [] } });

it("saves an equal-default preference explicitly, keeps aliases separate and resets the preference", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "管理显示名称" }));
  const row = await screen.findByRole("row", { name: /分缝发型.*默认名称/ });
  expect(within(row).getByText("分发")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "保存偏好" }));
  await within(row).findByText(/显式偏好/);
  expect(edits[0]).toEqual({ catalogId: "shared", edit: { kind: "prefer", name: { lang: "zh-CN", name: "分缝发型" } } });
  fireEvent.click(within(row).getByRole("button", { name: "恢复默认" }));
  await within(row).findByText(/默认名称/);
  expect(edits[1]).toEqual({ catalogId: "shared", edit: { kind: "reset", lang: "zh-CN" } });
  fireEvent.change(screen.getByRole("textbox", { name: "名称语言" }), { target: { value: "en" } });
  expect(screen.getByRole("textbox", { name: /偏好名称/ }).getAttribute("value")).toBe("Parted hair");
});

it("discards a late name edit result when safe mode changes", async () => {
  const data = workspace();
  let finish: (value: ReturnType<typeof workspace>) => void = () => {};
  const pending = new Promise<ReturnType<typeof workspace>>((resolve) => { finish = resolve; });
  mockIPC((cmd) => cmd.endsWith("edit_tag_name") ? pending : cmd.endsWith("inspect_tag_catalog") ? data : undefined, { shouldMockEvents: true });
  render(<TagNamePanel />);
  fireEvent.click(screen.getByRole("button", { name: "管理显示名称" }));
  fireEvent.click(await screen.findByRole("button", { name: "保存偏好" }));
  await act(async () => { await emit("safe-mode-setting", true); finish(data); await pending; });
  expect(screen.queryByRole("button", { name: "保存偏好" })).toBeNull();
});

it("edits one selected tag at a time and finds it by a separate alias in a large catalog", async () => {
  const data = workspace();
  data.catalog.tags = Array.from({ length: 150 }, (_, index) => ({ ...tag(), id: `shared-${index}`, names: [{ lang: "zh-CN", name: `发型 ${index}` }], aliases: [{ lang: "zh-CN", name: index === 149 ? "目标别名" : `叫法 ${index}` }] }));
  mockIPC((cmd) => cmd.endsWith("inspect_tag_catalog") ? data : undefined);
  render(<TagNamePanel />);
  fireEvent.click(screen.getByRole("button", { name: "管理显示名称" }));
  await screen.findAllByRole("button", { name: "保存偏好" });
  expect(screen.getAllByRole("button", { name: "保存偏好" })).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "查找要改名称的标签" }), { target: { value: "目标别名" } });
  expect(screen.getByRole("textbox", { name: /偏好名称/ }).getAttribute("value")).toBe("发型 149");
});
