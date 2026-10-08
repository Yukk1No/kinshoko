import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import { emit } from "@tauri-apps/api/event";
import { LegacyNameMigrationPanel, LegacyNameMigrationNotice } from "./LegacyNameMigrationPanel";

afterEach(() => { cleanup(); clearMocks(); });
const view = (): LegacyNameMigrationWorkspace => ({
  libraries: ["a", "b"].map((id) => ({ library: { id, name: `旧库 ${id}`, root: `C:/${id}` }, unavailable: null })),
  plan: { revision: 7, groups: [{ catalogId: "shared", namespace: "general", lang: "zh-CN", defaultName: "分缝发型", existingPreference: "自然分缝", affectedLibraries: ["a", "b"], sources: [{ libraryId: "a", localTagId: "local-a", legacyName: "分发", currentName: "自然分缝" }, { libraryId: "b", localTagId: "local-b", legacyName: "分开的头发", currentName: "自然分缝" }] }] },
});
it("lists both old names and existing preference, cancels without writing and previews the global choice before confirmation", async () => {
  const data = view();
  const writes: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("plan_legacy_names")) return data;
    if (cmd.endsWith("preview_legacy_names")) return { revision: 7, outcomes: [{ catalogId: "shared", lang: "zh-CN", displayName: "核心预览结果", preferenceName: null }] };
    if (cmd.endsWith("confirm_legacy_names")) { writes.push(args); return { ...data, plan: { revision: 8, groups: [] } }; }
  }, { shouldMockEvents: true });
  render(<LegacyNameMigrationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "迁移旧库名称" }));
  await screen.findByText("分开的头发");
  expect(screen.getByText("分发")).toBeTruthy();
  expect(screen.getByText(/^已有全局偏好：自然分缝$/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认本批次名称归属" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "default" } });
  expect(screen.getByText(/将撤回.*自然分缝.*跟随默认.*分缝发型/, { selector: "p" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消迁移" }));
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "迁移旧库名称" }));
  await screen.findByText("分开的头发");
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "legacy:1" } });
  expect(screen.getByText(/保存全局偏好.*分开的头发/, { selector: "p" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "确认本批次名称归属" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "确认本批次名称归属" }));
  await screen.findByText("本批次名称归属已保存。");
  expect(writes).toEqual([{ revision: 7, decisions: [{ catalogId: "shared", lang: "zh-CN", resolution: { kind: "keepLegacy", libraryId: "b", localTagId: "local-b" } }] }]);
});

it("offers the migration wizard when opening an old library whose name has already adopted a global preference", async () => {
  let opened = false;
  mockIPC((cmd) => cmd.endsWith("plan_legacy_names") ? view() : undefined, { shouldMockEvents: true });
  render(<LegacyNameMigrationNotice libraryId="b" safe={true} onOpen={() => { opened = true; }} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看旧名称迁移" }));
  expect(opened).toBe(true);
});

it("keeps the complete draft after a failed write and allows a single atomic retry", async () => {
  let fail = true;
  mockIPC((cmd) => {
    if (cmd.endsWith("plan_legacy_names")) return view();
    if (cmd.endsWith("preview_legacy_names")) return { revision: 7, outcomes: [{ catalogId: "shared", lang: "zh-CN", displayName: "核心预览结果", preferenceName: null }] };
    if (cmd.endsWith("confirm_legacy_names")) {
      if (fail) throw new Error("磁盘写入失败");
      return { ...view(), plan: { revision: 8, groups: [] } };
    }
  }, { shouldMockEvents: true });
  render(<LegacyNameMigrationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "迁移旧库名称" }));
  await screen.findByText("分开的头发");
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "preference" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "确认本批次名称归属" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "确认本批次名称归属" }));
  await screen.findByRole("alert");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "名称归属" }).value).toBe("preference");
  fail = false;
  await waitFor(() => expect(screen.getByRole("button", { name: "确认本批次名称归属" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "确认本批次名称归属" }));
  await screen.findByText("本批次名称归属已保存。");
});
it("clears migration data on a safe-mode change and discards a late plan", async () => {
  let finish: (value: ReturnType<typeof view>) => void = () => {};
  const pending = new Promise<ReturnType<typeof view>>((resolve) => { finish = resolve; });
  mockIPC((cmd) => cmd.endsWith("plan_legacy_names") ? pending : undefined, { shouldMockEvents: true });
  render(<LegacyNameMigrationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "迁移旧库名称" }));
  await act(async () => { await emit("safe-mode-setting", true); finish(view()); await pending; });
  expect(screen.queryByText("分开的头发")).toBeNull();
  expect(screen.queryByRole("button", { name: "确认本批次名称归属" })).toBeNull();
});

it("bulk-follows only unchosen non-conflicting names and pages the complete preview without replacing existing preferences", async () => {
  const data = view();
  const base = data.plan.groups[0];
  data.plan.groups = Array.from({ length: 250 }, (_, index) => ({ ...base, catalogId: `simple-${index}`, existingPreference: null, sources: [{ ...base.sources[0], localTagId: `local-${index}`, legacyName: `旧名称 ${index}` }] }));
  data.plan.groups.push({ ...base, catalogId: "with-preference", sources: [base.sources[0]] });
  data.plan.groups.push({ ...base, catalogId: "old-conflict", existingPreference: null });
  let saved: unknown;
  mockIPC((cmd, args) => {
    if (cmd.endsWith("plan_legacy_names")) return data;
    if (cmd.endsWith("preview_legacy_names")) return { revision: 7, outcomes: data.plan.groups.map((group, index) => ({ catalogId: group.catalogId, lang: group.lang, displayName: `最终名称 ${index}`, preferenceName: null })) };
    if (cmd.endsWith("confirm_legacy_names")) { saved = args; return { ...data, plan: { revision: 8, groups: [] } }; }
  }, { shouldMockEvents: true });
  render(<LegacyNameMigrationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "迁移旧库名称" }));
  fireEvent.click(await screen.findByRole("button", { name: /^未选无冲突项跟随默认/ }));
  expect(screen.getByText(/已选择 250 \/ 252/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认本批次名称归属" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一待选项" }));
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "名称归属" }).value).toBe("");
  expect(screen.getByText(/^已有全局偏好：自然分缝$/)).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "preference" } });
  fireEvent.click(screen.getByRole("button", { name: "下一待选项" }));
  expect(screen.getByText("同一统一标签存在不同旧名称，请明确选择。")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "legacy:0" } });
  const table = await screen.findByRole("table", { name: "迁移后最终显示" });
  expect(within(table).getAllByRole("row")).toHaveLength(21);
  expect(screen.queryByText("最终名称 250")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一页预览" }));
  expect(screen.getByText("最终名称 20")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "确认本批次名称归属" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "确认本批次名称归属" }));
  await screen.findByText("本批次名称归属已保存。");
  expect(saved).toMatchObject({ revision: 7, decisions: expect.arrayContaining([{ catalogId: "with-preference", lang: "zh-CN", resolution: { kind: "keepPreference" } }, { catalogId: "old-conflict", lang: "zh-CN", resolution: { kind: "keepLegacy", libraryId: "a", localTagId: "local-a" } }]) });
});

it("requires the preview for the current choices and ignores an earlier preview after the choice changes", async () => {
  let reads = 0;
  const outcome = (name: string) => ({ revision: 7, outcomes: [{ catalogId: "shared", lang: "zh-CN", displayName: name, preferenceName: null }] });
  let finish: (value: ReturnType<typeof outcome>) => void = () => {};
  const pending = new Promise<ReturnType<typeof outcome>>((resolve) => { finish = resolve; });
  const writes: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("plan_legacy_names")) return view();
    if (cmd.endsWith("preview_legacy_names")) return ++reads === 1 ? outcome("第一选择的预览") : pending;
    if (cmd.endsWith("confirm_legacy_names")) { writes.push(args); return { ...view(), plan: { revision: 8, groups: [] } }; }
  }, { shouldMockEvents: true });
  render(<LegacyNameMigrationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "迁移旧库名称" }));
  await screen.findByText("分开的头发");
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "preference" } });
  await screen.findByText("第一选择的预览");
  fireEvent.change(screen.getByRole("combobox", { name: "名称归属" }), { target: { value: "legacy:1" } });
  expect(screen.queryByText("第一选择的预览")).toBeNull();
  const confirm = screen.getByRole("button", { name: "确认本批次名称归属" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(confirm);
  expect(writes).toHaveLength(0);
  await act(async () => { finish(outcome("第二选择的预览")); await pending; });
  await screen.findByText("第二选择的预览");
  fireEvent.click(screen.getByRole("button", { name: "确认本批次名称归属" }));
  await screen.findByText("本批次名称归属已保存。");
  expect(writes).toEqual([{ revision: 7, decisions: [{ catalogId: "shared", lang: "zh-CN", resolution: { kind: "keepLegacy", libraryId: "b", localTagId: "local-b" } }] }]);
});
