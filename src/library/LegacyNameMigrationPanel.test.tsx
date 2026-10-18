import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import { emit } from "@tauri-apps/api/event";
import { useState } from "react";
import { LegacyNameBanner, LegacyNameMigrationNotice, LegacyNameWizard } from "./LegacyNameMigrationPanel";

afterEach(() => { cleanup(); clearMocks(); });
const view = (): LegacyNameMigrationWorkspace => ({
  libraries: ["a", "b"].map((id) => ({ library: { id, name: `旧库 ${id}`, root: `C:/${id}` }, unavailable: null })),
  plan: { revision: 7, groups: [{ catalogId: "shared", namespace: "general", lang: "zh-CN", defaultName: "分缝发型", existingPreference: "自然分缝", affectedLibraries: ["a", "b"], sources: [{ libraryId: "a", localTagId: "local-a", legacyName: "分发", currentName: "自然分缝" }, { libraryId: "b", localTagId: "local-b", legacyName: "分开的头发", currentName: "自然分缝" }] }] },
});

/** 主窗口里的用法：一个按钮打开向导，关闭时丢弃草稿。 */
function Host() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>逐个确认</button><LegacyNameWizard open={open} onOpenChange={setOpen} /></>;
}
const openWizard = async () => {
  fireEvent.click(screen.getByRole("button", { name: "逐个确认" }));
  return screen.findByRole("dialog", { name: "确认旧名称" });
};
const choose = (name: RegExp | string) => fireEvent.click(screen.getByRole("radio", { name }));
const next = () => fireEvent.click(screen.getByRole("button", { name: "下一个" }));
const confirmButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "确认名称" });

it("shows one old name at a time with both old names and the existing preference, cancels without writing and previews the final display before confirming", async () => {
  const data = view();
  const writes: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd.endsWith("plan_legacy_names")) return data;
    if (cmd.endsWith("preview_legacy_names")) return { revision: 7, outcomes: [{ catalogId: "shared", lang: "zh-CN", displayName: "核心预览结果", preferenceName: null }] };
    if (cmd.endsWith("confirm_legacy_names")) { writes.push(args); return { ...data, plan: { revision: 8, groups: [] } }; }
  }, { shouldMockEvents: true });
  render(<Host />);
  let wizard = await openWizard();
  await within(wizard).findByRole("radio", { name: /保留为全局偏好「分开的头发」/ });
  expect(within(wizard).getByText("1 / 1")).toBeTruthy();
  expect(within(wizard).getByRole("radio", { name: /保留为全局偏好「分发」/ })).toBeTruthy();
  expect(within(wizard).getByRole("radio", { name: /保留为全局偏好「自然分缝」.*之前定的/ })).toBeTruthy();
  // 不同旧叫法与已有叫法都是冲突，必须逐个决定。
  expect(within(wizard).getByText(/叫法不同，请选一个/)).toBeTruthy();
  expect(within(wizard).getByRole<HTMLButtonElement>("button", { name: /剩下的都用默认/ }).disabled).toBe(true);
  choose(/跟随默认.*「分缝发型」/);
  expect(within(wizard).getByText(/会撤回你的叫法「自然分缝」/)).toBeTruthy();
  fireEvent.click(within(wizard).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认旧名称" })).toBeNull());
  expect(writes).toHaveLength(0);

  wizard = await openWizard();
  await within(wizard).findByRole("radio", { name: /保留为全局偏好「分开的头发」/ });
  expect(within(wizard).getByRole<HTMLInputElement>("radio", { name: /跟随默认.*「分缝发型」/ }).checked).toBe(false);
  choose(/保留为全局偏好「分开的头发」/);
  next();
  const table = await within(wizard).findByRole("table", { name: "迁移后最终显示" });
  expect(within(table).getByText("核心预览结果")).toBeTruthy();
  // 标签列写标签名与语言，不写内部编号。
  expect(within(table).getByText("分缝发型 · 简体中文")).toBeTruthy();
  expect(within(table).queryByText(/shared/)).toBeNull();
  await waitFor(() => expect(confirmButton().disabled).toBe(false));
  fireEvent.click(confirmButton());
  await within(wizard).findByText("旧名称已确认。");
  expect(writes).toEqual([{ revision: 7, decisions: [{ catalogId: "shared", lang: "zh-CN", resolution: { kind: "keepLegacy", libraryId: "b", localTagId: "local-b" } }] }]);
});

it("offers the wizard when opening an old library whose name has already adopted a global preference", async () => {
  let opened = false;
  mockIPC((cmd) => cmd.endsWith("plan_legacy_names") ? view() : undefined, { shouldMockEvents: true });
  render(<LegacyNameMigrationNotice libraryId="b" safe={true} onOpen={() => { opened = true; }} />);
  expect(await screen.findByText(/旧名称待确认/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "逐个确认" }));
  expect(opened).toBe(true);
});

it("counts pending old names in the settings banner", async () => {
  let opened = false;
  mockIPC((cmd) => cmd.endsWith("plan_legacy_names") ? view() : undefined, { shouldMockEvents: true });
  render(<LegacyNameBanner onOpen={() => { opened = true; }} />);
  expect(await screen.findByText("1 个旧名称待确认")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "逐个确认" }));
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
  render(<Host />);
  const wizard = await openWizard();
  await within(wizard).findByRole("radio", { name: /保留为全局偏好「自然分缝」/ });
  choose(/保留为全局偏好「自然分缝」/);
  next();
  await waitFor(() => expect(confirmButton().disabled).toBe(false));
  fireEvent.click(confirmButton());
  expect((await within(wizard).findByRole("alert")).textContent).toContain("磁盘写入失败");
  fireEvent.click(within(wizard).getByRole("button", { name: "上一个" }));
  expect(within(wizard).getByRole<HTMLInputElement>("radio", { name: /保留为全局偏好「自然分缝」/ }).checked).toBe(true);
  fail = false;
  next();
  await waitFor(() => expect(confirmButton().disabled).toBe(false));
  fireEvent.click(confirmButton());
  await within(wizard).findByText("旧名称已确认。");
});

it("clears migration data on a safe-mode change and discards a late plan", async () => {
  let finish: (value: ReturnType<typeof view>) => void = () => {};
  const pending = new Promise<ReturnType<typeof view>>((resolve) => { finish = resolve; });
  mockIPC((cmd) => cmd.endsWith("plan_legacy_names") ? pending : undefined, { shouldMockEvents: true });
  render(<Host />);
  await openWizard();
  await act(async () => { await emit("safe-mode-setting", true); finish(view()); await pending; });
  expect(screen.queryByText(/分开的头发/)).toBeNull();
  expect(screen.queryByRole("button", { name: "确认名称" })).toBeNull();
});

it("uses the default only for remaining unchosen names without conflicts, leaves conflicts to be decided one by one and pages the complete preview", async () => {
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
  render(<Host />);
  const wizard = await openWizard();
  fireEvent.click(await within(wizard).findByRole("button", { name: "剩下的都用默认（250）" }));
  // 跳到第一个还要决定的：已有叫法不同于旧名称。
  expect(within(wizard).getByText(/已选 250 \/ 252/)).toBeTruthy();
  expect(within(wizard).getByText("251 / 252")).toBeTruthy();
  expect(within(wizard).getByRole<HTMLInputElement>("radio", { name: /跟随默认.*「分缝发型」/ }).checked).toBe(false);
  expect(within(wizard).getByRole<HTMLButtonElement>("button", { name: /剩下的都用默认/ }).disabled).toBe(true);
  choose(/保留为全局偏好「自然分缝」/);
  next();
  expect(within(wizard).getByText("252 / 252")).toBeTruthy();
  expect(within(wizard).getByText(/叫法不同，请选一个/)).toBeTruthy();
  // 没选完不能进入确认。
  next();
  expect(within(wizard).queryByRole("table", { name: "迁移后最终显示" })).toBeNull();
  choose(/保留为全局偏好「分发」/);
  next();
  const table = await within(wizard).findByRole("table", { name: "迁移后最终显示" });
  expect(within(table).getAllByRole("row")).toHaveLength(21);
  expect(within(wizard).queryByText("最终名称 250")).toBeNull();
  fireEvent.click(within(wizard).getByRole("button", { name: "下一页" }));
  expect(within(wizard).getByText("最终名称 20")).toBeTruthy();
  await waitFor(() => expect(confirmButton().disabled).toBe(false));
  fireEvent.click(confirmButton());
  await within(wizard).findByText("旧名称已确认。");
  expect(saved).toMatchObject({ revision: 7, decisions: expect.arrayContaining([
    { catalogId: "simple-0", lang: "zh-CN", resolution: { kind: "followDefault" } },
    { catalogId: "with-preference", lang: "zh-CN", resolution: { kind: "keepPreference" } },
    { catalogId: "old-conflict", lang: "zh-CN", resolution: { kind: "keepLegacy", libraryId: "a", localTagId: "local-a" } },
  ]) });
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
  render(<Host />);
  const wizard = await openWizard();
  await within(wizard).findByRole("radio", { name: /保留为全局偏好「自然分缝」/ });
  choose(/保留为全局偏好「自然分缝」/);
  next();
  await within(wizard).findByText("第一选择的预览");
  fireEvent.click(within(wizard).getByRole("button", { name: "上一个" }));
  choose(/保留为全局偏好「分开的头发」/);
  next();
  expect(within(wizard).queryByText("第一选择的预览")).toBeNull();
  expect(confirmButton().disabled).toBe(true);
  fireEvent.click(confirmButton());
  expect(writes).toHaveLength(0);
  await act(async () => { finish(outcome("第二选择的预览")); await pending; });
  await within(wizard).findByText("第二选择的预览");
  fireEvent.click(confirmButton());
  await within(wizard).findByText("旧名称已确认。");
  expect(writes).toEqual([{ revision: 7, decisions: [{ catalogId: "shared", lang: "zh-CN", resolution: { kind: "keepLegacy", libraryId: "b", localTagId: "local-b" } }] }]);
});

it("coalesces a burst of vocabulary changes during automatic tagging into one plan in flight at a time and still shows the final state (#142)", async () => {
  // 自动打标每写一张图都发 vocabularyChanged；旧名称检查很重，不能一事件一请求地堆进后端阻塞线程池。
  let state = view();
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  mockIPC((cmd) => {
    if (!cmd.endsWith("plan_legacy_names")) return undefined;
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    // 后端按收到请求时的词表作答，慢于事件间隔。
    const answer = structuredClone(state);
    return new Promise((resolve) => setTimeout(() => { inFlight--; resolve(answer); }, 25));
  }, { shouldMockEvents: true });
  render(<LegacyNameMigrationNotice libraryId="a" safe={true} onOpen={() => {}} />);
  expect(await screen.findByText(/这个图库里有 1 个较早的叫法/)).toBeTruthy();
  calls = 0;
  for (let index = 0; index < 50; index++) {
    // 最后一次写入后多出一个待确认的旧名称：最终显示要反映它。
    if (index === 49) state = { ...state, plan: { ...state.plan, groups: [...state.plan.groups, { ...state.plan.groups[0], catalogId: "later" }] } };
    await act(async () => {
      await emit("library-event", { kind: "vocabularyChanged", libraryId: "a" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(await screen.findByText(/这个图库里有 2 个较早的叫法/, {}, { timeout: 2000 })).toBeTruthy();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(peak).toBe(1);
  expect(calls).toBeLessThan(25);
  expect(inFlight).toBe(0);
});
